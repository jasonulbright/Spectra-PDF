"""Link-region management (Links).

Links are navigation regions (a /Link annotation with an action or an internal
destination), NOT comments — so they get their own manager rather than riding
the annotation/comment model: list every link with its target and its border,
retarget one, restyle one, or delete it. Links are addressed by (1-based page,
index among that page's links).

A target is one structured dict, the same vocabulary read and written and the
same one the renderer speaks (``src/renderer/lib/links.ts``)::

    {"kind": "uri",    "url": str}
    {"kind": "goto",   "page": int (1-based), "view": View}
    {"kind": "named",  "name": str}
    {"kind": "file",   "path": str, "page": int | None, "view": View,
                       "new_window": bool | None}
    {"kind": "launch", "path": str}
    {"kind": "other",  "action": str}
    {"kind": "none"}

``launch``, ``other`` and ``none`` are REPORTED and never authored: a /Launch
names a program for the OS to run, and nothing here can say what an unknown
action does. Every one of them keeps its bytes.

A View is the destination array's own vocabulary::

    {"mode": "inherit"}                      [pg /XYZ null null null]
    {"mode": "xyz",   "left", "top", "zoom"} any of the three may be None
    {"mode": "fit"}   {"mode": "fitb"}
    {"mode": "fith",  "top"}  {"mode": "fitbh", "top"}
    {"mode": "fitv",  "left"} {"mode": "fitbv", "left"}
    {"mode": "fitr",  "left", "bottom", "right", "top"}

A border is ``{"width", "style", "dashes", "color", "highlight"}``. Width 0 is
invisible and is the default: /Border [0 0 0], no /BS, no /C — the byte shape
links have always been written with, so a derived or selection-authored link
is unchanged by this module gaining an appearance vocabulary.
"""

import shutil
from pathlib import Path

import pikepdf
from pikepdf import Array, Dictionary, Name, String
from engine.fieldactions import destination_page as _resolve_dest_page
from engine.inplace import is_same_file, staged_write
from engine.pdf_save import save_pdf

#: Border styles this module AUTHORS. Reading covers /B and /I (beveled,
#: inset) because a document may carry them; writing does not, since no
#: authoring surface offers a control for them.
AUTHORED_STYLES = ("solid", "dashed", "underline")

_STYLE_BY_NAME = {"/S": "solid", "/D": "dashed", "/U": "underline", "/B": "beveled", "/I": "inset"}
_NAME_BY_STYLE = {"solid": "/S", "dashed": "/D", "underline": "/U"}

#: /H highlight modes. /I (invert) is the format's default and the one a
#: reader applies when /H is absent.
_HIGHLIGHT_BY_NAME = {"/N": "none", "/I": "invert", "/O": "outline", "/P": "push"}
_NAME_BY_HIGHLIGHT = {"none": "/N", "invert": "/I", "outline": "/O", "push": "/P"}
DEFAULT_HIGHLIGHT = "invert"

#: Destination view modes, and how many coordinate operands each one carries
#: after its mode name.
_VIEW_OPERANDS = {
    "xyz": ("left", "top", "zoom"),
    "fit": (),
    "fith": ("top",),
    "fitv": ("left",),
    "fitr": ("left", "bottom", "right", "top"),
    "fitb": (),
    "fitbh": ("top",),
    "fitbv": ("left",),
}
_MODE_BY_NAME = {
    "/XYZ": "xyz",
    "/Fit": "fit",
    "/FitH": "fith",
    "/FitV": "fitv",
    "/FitR": "fitr",
    "/FitB": "fitb",
    "/FitBH": "fitbh",
    "/FitBV": "fitbv",
}
_NAME_BY_MODE = {v: k for k, v in _MODE_BY_NAME.items()}


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


def _file_spec(value) -> str:
    """A file specification as its path string. Both the plain-string form and
    the dictionary form (/F, or /UF where the producer wrote Unicode)."""
    if value is None:
        return ""
    if isinstance(value, pikepdf.String):
        return str(value)
    if isinstance(value, Dictionary):
        for key in ("/UF", "/F"):
            inner = value.get(key)
            if inner is not None:
                return str(inner)
    return ""


def _number(value) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _read_view(dest) -> dict:
    """The view half of an explicit destination array — everything after the
    page reference. A destination naming no mode is /XYZ by omission in
    practice; it is reported as inherit, which is what a reader does with it."""
    if not isinstance(dest, pikepdf.Array) or len(dest) < 2:
        return {"mode": "inherit"}
    mode = _MODE_BY_NAME.get(str(dest[1]))
    if mode is None:
        return {"mode": "inherit"}
    operands = _VIEW_OPERANDS[mode]
    values = [_number(dest[2 + i]) if len(dest) > 2 + i else None for i in range(len(operands))]
    if mode == "xyz" and all(v is None for v in values):
        # [pg /XYZ null null null] is "this page, at the reader's own zoom".
        return {"mode": "inherit"}
    return {"mode": mode, **dict(zip(operands, values))}


def _remote_page(dest) -> int | None:
    """The 1-based page a REMOTE destination names. It cannot be resolved
    against a page tree — the pages live in the other document — so only the
    integer form says anything, and a named one says nothing here."""
    if isinstance(dest, pikepdf.Array) and len(dest) > 0:
        try:
            return int(dest[0]) + 1
        except (TypeError, ValueError):
            return None
    return None


def _dest_of(pdf, annot):
    """The destination a link carries, action or bare /Dest."""
    a = annot.get("/A")
    if isinstance(a, Dictionary) and a.get("/D") is not None:
        return a.get("/D")
    return annot.get("/Dest")


def _target_spec(pdf, annot) -> dict:
    """One link's target, in the structured vocabulary."""
    a = annot.get("/A")
    if isinstance(a, Dictionary):
        try:
            s = str(a.get("/S"))
        except (TypeError, ValueError):
            s = ""
        if s == "/URI":
            uri = a.get("/URI")
            return {"kind": "uri", "url": str(uri) if uri is not None else ""}
        if s == "/Launch":
            return {"kind": "launch", "path": _file_spec(a.get("/F"))}
        if s in ("/GoToR", "/GoToE"):
            dest = a.get("/D")
            spec = {
                "kind": "file",
                "path": _file_spec(a.get("/F")),
                "page": _remote_page(dest),
                "view": _read_view(dest),
            }
            new_window = a.get("/NewWindow")
            if new_window is not None:
                spec["new_window"] = bool(new_window)
            return spec
        if s != "/GoTo":
            return {"kind": "other", "action": s.lstrip("/") or "action"}
    dest = _dest_of(pdf, annot)
    if dest is None:
        return {"kind": "none"}
    if isinstance(dest, (pikepdf.Name, pikepdf.String)):
        return {"kind": "named", "name": str(dest).lstrip("/")}
    page = _resolve_dest_page(pdf, dest)
    return {
        "kind": "goto",
        "page": page + 1 if page is not None else None,
        "view": _read_view(dest),
    }


def _describe(spec: dict) -> tuple[str, str]:
    """(kind, one-line target description) for the listing. The description is
    a LABEL — the panel renders the structured spec; this is what a caller with
    only a line of space shows, and what the CLI prints."""
    kind = spec["kind"]
    if kind == "uri":
        return ("uri", spec["url"])
    if kind == "goto":
        page = spec.get("page")
        return ("internal", f"Page {page}" if page is not None else "internal link")
    if kind == "named":
        return ("named", spec["name"])
    if kind == "file":
        page = spec.get("page")
        path = spec.get("path") or "(no file)"
        return ("file", f"{path} page {page}" if page is not None else path)
    if kind == "launch":
        return ("launch", spec.get("path") or "(no file)")
    if kind == "other":
        return ("other", spec.get("action") or "action")
    return ("other", "none")


def _read_appearance(annot) -> dict:
    """A link's border, /BS first and /Border as the fallback.

    /BS is the current definition and /Border the legacy one; a document
    carrying both is read from /BS, which is the order a conforming consumer
    resolves them in.
    """
    width = None
    style = "solid"
    dashes = None
    bs = annot.get("/BS")
    if isinstance(bs, Dictionary):
        width = _number(bs.get("/W"))
        style = _STYLE_BY_NAME.get(str(bs.get("/S")) if bs.get("/S") is not None else "/S", "solid")
        raw = bs.get("/D")
        if isinstance(raw, Array):
            dashes = [v for v in (_number(x) for x in raw) if v is not None]
    if width is None:
        border = annot.get("/Border")
        if isinstance(border, Array) and len(border) >= 3:
            width = _number(border[2])
            if len(border) >= 4 and isinstance(border[3], Array):
                style = "dashed"
                dashes = [v for v in (_number(x) for x in border[3]) if v is not None]
        else:
            # No /Border and no /BS: the format's default is a 1-unit solid
            # border. Reporting 0 would tell the user their link is invisible
            # when every reader draws a box around it.
            width = 1.0
    color = None
    raw_color = annot.get("/C")
    if isinstance(raw_color, Array) and len(raw_color) == 3:
        parsed = [_number(v) for v in raw_color]
        if all(v is not None for v in parsed):
            color = parsed
    highlight = DEFAULT_HIGHLIGHT
    raw_h = annot.get("/H")
    if raw_h is not None:
        highlight = _HIGHLIGHT_BY_NAME.get(str(raw_h), DEFAULT_HIGHLIGHT)
    out = {
        "width": float(width or 0.0),
        "style": style,
        "color": color,
        "highlight": highlight,
    }
    if dashes:
        out["dashes"] = dashes
    return out


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
                spec = _target_spec(pdf, annot)
                kind, target = _describe(spec)
                links.append(
                    {
                        "page": pi + 1,
                        "index": li,
                        "kind": kind,
                        "target": target,
                        "rect": _rect(annot),
                        "target_spec": spec,
                        "appearance": _read_appearance(annot),
                    }
                )
        return {"links": links, "count": len(links)}


def _named_destinations_of(pdf) -> list[dict]:
    """Every named destination an OPEN document declares, /Names /Dests first
    and then the legacy /Dests dictionary — the resolution order every reader
    of a name follows. Sorted by name: a name tree is stored sorted and the
    legacy dictionary is not, so listing them in encounter order would present
    two documents saying the same thing in two different orders."""
    out: list[dict] = []
    seen: set[str] = set()
    names = pdf.Root.get("/Names")
    if names is not None and names.get("/Dests") is not None:
        try:
            items = list(pikepdf.NameTree(names.get("/Dests")).items())
        except (TypeError, ValueError, KeyError, RuntimeError):
            items = []
        for key, dest in items:
            name = str(key)
            if name in seen:
                continue
            seen.add(name)
            out.append({"name": name, "page": _page_of_dest(pdf, dest)})
    legacy = pdf.Root.get("/Dests")
    if isinstance(legacy, Dictionary):
        for key in legacy.keys():
            name = str(key).lstrip("/")
            if name in seen:
                continue
            seen.add(name)
            out.append({"name": name, "page": _page_of_dest(pdf, legacy.get(key))})
    out.sort(key=lambda d: d["name"])
    return out


def _page_of_dest(pdf, dest) -> int | None:
    page = _resolve_dest_page(pdf, dest)
    return page + 1 if page is not None else None


def list_named_destinations(file: str) -> dict:
    """Every named destination the document declares, with the page it lands
    on. The `named` target kind picks from THIS list, so an author chooses a
    name the document has rather than typing one that resolves to nothing."""
    with pikepdf.open(file) as pdf:
        out = _named_destinations_of(pdf)
    return {"destinations": out, "count": len(out)}


# ── authoring a target ────────────────────────────────────────────────────


def _view_operands(view) -> list:
    """The operands that follow the mode name in a destination array."""
    spec = view if isinstance(view, dict) else {}
    mode = str(spec.get("mode") or "inherit")
    if mode == "inherit":
        return [Name("/XYZ"), None, None, None]
    if mode not in _VIEW_OPERANDS:
        raise ValueError(f"unknown link view mode {mode}")
    out = [Name(_NAME_BY_MODE[mode])]
    for key in _VIEW_OPERANDS[mode]:
        raw = spec.get(key)
        if raw is None:
            out.append(None)
            continue
        try:
            out.append(float(raw))
        except (TypeError, ValueError):
            raise ValueError(f"link view {key} must be a number") from None
    return out


def _goto_dest(pdf, spec: dict):
    page_no = spec.get("page")
    try:
        page_no = int(page_no)
    except (TypeError, ValueError):
        raise ValueError("a link to a page needs a page number") from None
    if not (1 <= page_no <= len(pdf.pages)):
        raise ValueError(f"page {page_no} is out of range (1-{len(pdf.pages)})")
    return Array([pdf.pages[page_no - 1].obj, *_view_operands(spec.get("view"))])


def _remote_dest(spec: dict):
    """A destination in ANOTHER document. Its first element is a page INDEX,
    not a reference — there is no page tree here to reference."""
    raw = spec.get("page")
    if raw is None:
        return None
    try:
        page_no = int(raw)
    except (TypeError, ValueError):
        raise ValueError("a link to a file needs a whole page number") from None
    if page_no < 1:
        raise ValueError("a link to a file needs a whole page number")
    return Array([page_no - 1, *_view_operands(spec.get("view"))])


def target_dictionary(pdf, target: dict):
    """An authored target as an action dictionary, or None when the target is
    a bare named destination (which is written to /Dest instead).

    Only the authored kinds are written. The shapes are the ones the ecosystem
    writes, so another viewer performs what this app authored.
    """
    kind = str((target or {}).get("kind") or "")
    if kind == "uri":
        url = str(target.get("url") or "").strip()
        if not url:
            raise ValueError("url must not be empty")
        return Dictionary(Type=Name.Action, S=Name.URI, URI=String(url))
    if kind == "goto":
        return Dictionary(Type=Name.Action, S=Name("/GoTo"), D=_goto_dest(pdf, target))
    if kind == "named":
        name = str(target.get("name") or "").strip()
        if not name:
            raise ValueError("a named destination link needs a name")
        known = {d["name"] for d in _named_destinations_of(pdf)}
        if name not in known:
            raise ValueError(f"this document has no destination named {name}")
        return None
    if kind == "file":
        path = str(target.get("path") or "").strip()
        if not path:
            raise ValueError("a link to a file needs a path")
        node = Dictionary(Type=Name.Action, S=Name("/GoToR"), F=String(path))
        dest = _remote_dest(target)
        if dest is not None:
            node["/D"] = dest
        if target.get("new_window") is not None:
            node["/NewWindow"] = bool(target.get("new_window"))
        return node
    raise ValueError(f"unknown link target {kind or '(none)'}")


def _write_target(pdf, annot, target: dict) -> None:
    """Replace a link's target, TOTALLY: the /A and the /Dest are both
    rewritten, so a link that carried one and now needs the other cannot end
    up carrying two targets that disagree."""
    action = target_dictionary(pdf, target)
    if action is None:
        annot["/Dest"] = String(str(target["name"]).strip())
        if "/A" in annot:
            del annot["/A"]
        return
    annot["/A"] = pdf.make_indirect(action)
    if "/Dest" in annot:
        del annot["/Dest"]


# ── authoring an appearance ───────────────────────────────────────────────


def _color_array(raw) -> Array:
    try:
        values = [float(v) for v in raw]
    except (TypeError, ValueError):
        raise ValueError("link colour must be three numbers from 0 to 1") from None
    if len(values) != 3 or any(v < 0 or v > 1 for v in values):
        raise ValueError("link colour must be three numbers from 0 to 1")
    return Array(values)


def _write_appearance(annot, appearance) -> None:
    """Write a link's border. A width of 0 lands the invisible byte shape —
    /Border [0 0 0] and nothing else — which is what every link this app has
    ever written carries, so the default is byte-identical to the old one."""
    spec = appearance if isinstance(appearance, dict) else {}
    raw_width = spec.get("width", 0)
    try:
        width = float(raw_width)
    except (TypeError, ValueError):
        raise ValueError("link border width must be a number") from None
    if width < 0:
        raise ValueError("link border width must not be negative")
    style = str(spec.get("style") or "solid")
    if style not in AUTHORED_STYLES:
        raise ValueError("link border style must be solid, dashed or underline")

    for key in ("/BS", "/C", "/H"):
        if key in annot:
            del annot[key]
    # A whole width is written as an integer: 0 is the default every link this
    # app has ever carried, and `0.0` would change those bytes for nothing.
    number = int(width) if float(width).is_integer() else width
    annot["/Border"] = Array([0, 0, number])
    if width > 0:
        bs = Dictionary(Type=Name("/Border"), W=number, S=Name(_NAME_BY_STYLE[style]))
        if style == "dashed":
            raw = spec.get("dashes") or [3]
            try:
                dashes = [float(v) for v in raw]
            except (TypeError, ValueError):
                raise ValueError("link dash pattern must be numbers") from None
            if not dashes or any(v < 0 for v in dashes):
                raise ValueError("link dash pattern must be numbers")
            bs["/D"] = Array(dashes)
        annot["/BS"] = bs
        if spec.get("color") is not None:
            annot["/C"] = _color_array(spec.get("color"))
    highlight = str(spec.get("highlight") or DEFAULT_HIGHLIGHT)
    if highlight not in _NAME_BY_HIGHLIGHT:
        raise ValueError("link highlight must be none, invert, outline or push")
    # /I is the format's own default; writing it would be noise, and a reader
    # that finds no /H applies exactly it.
    if highlight != DEFAULT_HIGHLIGHT:
        annot["/H"] = Name(_NAME_BY_HIGHLIGHT[highlight])


def _nth_link(pdf, page_no: int, index: int):
    if not (1 <= int(page_no) <= len(pdf.pages)):
        raise ValueError(f"page {page_no} is out of range (1-{len(pdf.pages)})")
    links = _links_on(pdf.pages[int(page_no) - 1])
    if not (0 <= int(index) < len(links)):
        raise ValueError(f"link index {index} is out of range (page has {len(links)})")
    return links[int(index)]


def set_link_target(file: str, output: str, page: int, index: int, target: dict) -> dict:
    """Retarget a link (replaces any existing action AND destination)."""
    input_path, output_path = Path(file), Path(output)
    same_file = is_same_file(str(input_path), str(output_path))
    with pikepdf.open(file) as pdf:
        annot = _nth_link(pdf, page, index)
        _write_target(pdf, annot, target or {})
        spec = _target_spec(pdf, annot)
        preserved = _save(pdf, input_path, output_path, same_file)
    out = {"output": str(output_path), "page": int(page), "index": int(index), "target": spec}
    if preserved:
        out["signatures_preserved"] = True
    return out


def set_link_url(file: str, output: str, page: int, index: int, url: str) -> dict:
    """Retarget a link to a URL. The URI case of `set_link_target`, kept as its
    own entry point because a caller that only has a URL should not have to
    build a target dictionary to say so."""
    if not str(url).strip():
        raise ValueError("url must not be empty")
    result = set_link_target(file, output, page, index, {"kind": "uri", "url": str(url)})
    result.pop("target", None)
    result["url"] = str(url)
    return result


def set_link_appearance(file: str, output: str, page: int, index: int, appearance: dict) -> dict:
    """Restyle a link's border. Total: every border key is rewritten from the
    request, so a style left out is REMOVED rather than left behind."""
    input_path, output_path = Path(file), Path(output)
    same_file = is_same_file(str(input_path), str(output_path))
    with pikepdf.open(file) as pdf:
        annot = _nth_link(pdf, page, index)
        _write_appearance(annot, appearance)
        landed = _read_appearance(annot)
        preserved = _save(pdf, input_path, output_path, same_file)
    out = {"output": str(output_path), "page": int(page), "index": int(index), "appearance": landed}
    if preserved:
        out["signatures_preserved"] = True
    return out


def set_link_rect(file: str, output: str, page: int, index: int, rect: list) -> dict:
    """Move or resize a link's region. The geometry half of editing an
    existing link — the canvas hands back the rect it dragged."""
    input_path, output_path = Path(file), Path(output)
    same_file = is_same_file(str(input_path), str(output_path))
    with pikepdf.open(file) as pdf:
        annot = _nth_link(pdf, page, index)
        annot["/Rect"] = Array(_normalized_rect(rect))
        preserved = _save(pdf, input_path, output_path, same_file)
    out = {"output": str(output_path), "page": int(page), "index": int(index)}
    if preserved:
        out["signatures_preserved"] = True
    return out


def _normalized_rect(raw) -> list[float]:
    values = [float(v) for v in raw]
    if len(values) != 4:
        raise ValueError("rect must be [x0, y0, x1, y1]")
    x0, y0 = min(values[0], values[2]), min(values[1], values[3])
    x1, y1 = max(values[0], values[2]), max(values[1], values[3])
    if x1 - x0 <= 0 or y1 - y0 <= 0:
        raise ValueError("rect must have a positive width and height")
    return [x0, y0, x1, y1]


def add_links(file: str, output: str, links: list) -> dict:
    """Create /Link annotations.

    `links` is a list of {page (1-based), rect [x0,y0,x1,y1] in PDF user space}
    plus a target and, optionally, an appearance. The target is either a
    structured `target` dict or the shorthand `url`, which is the URI case
    spelled out — a text selection and a derived link both arrive with the
    shorthand and nothing about their bytes changes.

    Every link is validated BEFORE any of them is written, so a batch carrying
    one bad target lands nothing rather than half of itself.

    The default appearance is an INVISIBLE border, /Border [0 0 0] — the
    convention every mainstream authoring tool uses; a visible ring around
    linked text is not what a selection gesture asked for. A drawn link that
    wants a visible border says so.
    """
    if not links:
        raise ValueError("no links to add")
    input_path, output_path = Path(file), Path(output)
    same_file = is_same_file(str(input_path), str(output_path))
    with pikepdf.open(file) as pdf:
        prepared = []
        for spec in links:
            page_no = int(spec["page"])
            if not (1 <= page_no <= len(pdf.pages)):
                raise ValueError(f"page {page_no} is out of range (1-{len(pdf.pages)})")
            target = spec.get("target")
            if not isinstance(target, dict):
                target = {"kind": "uri", "url": str(spec.get("url", ""))}
            action = target_dictionary(pdf, target)
            prepared.append((page_no, _normalized_rect(spec["rect"]), target, action, spec.get("appearance")))
        for page_no, rect, target, action, appearance in prepared:
            pg = pdf.pages[page_no - 1]
            annot = pdf.make_indirect(
                Dictionary(Type=Name.Annot, Subtype=Name.Link, Rect=Array(rect))
            )
            if action is None:
                annot["/Dest"] = String(str(target["name"]).strip())
            else:
                annot["/A"] = pdf.make_indirect(action)
            _write_appearance(annot, appearance)
            existing = pg.obj.get("/Annots")
            pg.obj["/Annots"] = Array([*existing, annot]) if existing is not None else Array([annot])
        preserved = _save(pdf, input_path, output_path, same_file)
    out = {"output": str(output_path), "added": len(prepared)}
    if preserved:
        out["signatures_preserved"] = True
    return out


def delete_link(file: str, output: str, page: int, index: int) -> dict:
    """Remove one link annotation from a page."""
    input_path, output_path = Path(file), Path(output)
    same_file = is_same_file(str(input_path), str(output_path))
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
    signature they ride beside. Returns whether that preservation ran.

    A same-file write stages beside the document and swaps the directory
    entry, so a write that dies leaves the input whole. The preservation reads
    the input at its own path, so it runs against the staged bytes before the
    swap; the Pdf is closed after it because the destination cannot be
    replaced while it is held open."""
    from engine.incremental import finalize_preserving_signatures

    if same_file:
        with staged_write(output_path) as staged:
            save_pdf(pdf, str(staged))
            preserved = finalize_preserving_signatures(str(input_path), str(staged))
            pdf.close()
    else:
        save_pdf(pdf, output_path)
        preserved = finalize_preserving_signatures(str(input_path), str(output_path))
    return bool(preserved.get("preserved"))
