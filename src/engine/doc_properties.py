"""Document-level properties the Properties dialog's Initial View and Advanced
tabs read and write.

Initial view is three unrelated catalog keys presented as one panel:
``/PageLayout`` (how pages are laid out), ``/PageMode`` (which navigation pane
opens), and ``/OpenAction`` (the opening page and its magnification, spelled as
a destination). ``/ViewerPreferences`` carries the window options and the
reading direction.

Advanced is the trailer info dict's ``/Trapped`` and the catalog's ``/URI
/Base``, plus read-only facts about the file itself.

Absent means default for every ``/ViewerPreferences`` boolean (ISO 32000
§12.2 table 150) and for ``/Direction`` (``/L2R``), so writing false and
deleting the key produce the same document — the setter deletes, and a file
that never had a ``/ViewerPreferences`` dict does not grow an empty one.
"""

from pathlib import Path

import pikepdf
from pikepdf import Array, Dictionary, Name, String

from .inplace import finish_staged, is_same_file, staging_target
from engine.pdf_save import save_pdf

# panel value → /PageLayout name. "default" is the absent key.
_PAGE_LAYOUTS = {
    "single-page": "SinglePage",
    "one-column": "OneColumn",
    "two-column-left": "TwoColumnLeft",
    "two-column-right": "TwoColumnRight",
    "two-page-left": "TwoPageLeft",
    "two-page-right": "TwoPageRight",
}
_PAGE_LAYOUTS_INVERSE = {v: k for k, v in _PAGE_LAYOUTS.items()}

# panel value → /PageMode name.
_PAGE_MODES = {
    "none": "UseNone",
    "outlines": "UseOutlines",
    "thumbnails": "UseThumbs",
    "full-screen": "FullScreen",
    "oc": "UseOC",
    "attachments": "UseAttachments",
}
_PAGE_MODES_INVERSE = {v: k for k, v in _PAGE_MODES.items()}

# The window options, panel key → /ViewerPreferences key. Each defaults to
# false when absent.
_WINDOW_OPTIONS = {
    "hide_toolbar": "HideToolbar",
    "hide_menubar": "HideMenubar",
    "hide_window_ui": "HideWindowUI",
    "fit_window": "FitWindow",
    "center_window": "CenterWindow",
    "display_doc_title": "DisplayDocTitle",
}

_ZOOM_MODES = ("default", "fit-page", "fit-width", "fit-height", "fit-visible", "percent")

# The magnification range the panel offers. Below 1% nothing is legible and
# above 6400% a destination is a rendering hazard rather than a view.
_ZOOM_MIN = 1.0
_ZOOM_MAX = 6400.0

_TRAPPED = {"true": "True", "false": "False", "unknown": "Unknown"}
_TRAPPED_INVERSE = {v: k for k, v in _TRAPPED.items()}


def _page_index_of(pdf, page_obj) -> int | None:
    """0-based index of a page object within the document, by object identity.
    A destination naming a page that is not in the page tree (a stale
    reference a producer left behind) resolves to None rather than guessing."""
    try:
        target = page_obj.objgen
    except AttributeError:
        return None
    for i, page in enumerate(pdf.pages):
        try:
            if page.obj.objgen == target:
                return i
        except AttributeError:
            continue
    return None


def _resolve_named_destination(pdf, name):
    """A destination named by string/name: the /Names /Dests name tree first,
    then the legacy /Dests dictionary. Returns the destination array or None."""
    key = str(name)
    names = pdf.Root.get("/Names")
    if names is not None:
        dests = names.get("/Dests")
        if dests is not None:
            try:
                found = pikepdf.NameTree(dests).get(key.lstrip("/"))
            except (TypeError, ValueError, KeyError, RuntimeError):
                found = None
            if found is not None:
                return found
    legacy = pdf.Root.get("/Dests")
    if legacy is not None:
        try:
            found = legacy.get("/" + key.lstrip("/"))
        except (TypeError, ValueError, AttributeError):
            found = None
        if found is not None:
            return found
    return None


def _destination_array(pdf, dest):
    """Normalize a destination to its ARRAY form. A destination dictionary
    keeps the array under /D; a name/string destination is looked up."""
    if isinstance(dest, pikepdf.Array):
        return dest
    if isinstance(dest, pikepdf.Dictionary):
        inner = dest.get("/D")
        return inner if isinstance(inner, pikepdf.Array) else None
    if isinstance(dest, (pikepdf.Name, pikepdf.String)):
        resolved = _resolve_named_destination(pdf, dest)
        if resolved is None:
            return None
        return _destination_array(pdf, resolved)
    return None


def _open_action_destination(pdf):
    """The /OpenAction as a destination ARRAY, or None. An /OpenAction that is
    an ACTION dictionary is a destination only when it is a /GoTo carrying
    one — a /JavaScript open script is not."""
    action = pdf.Root.get("/OpenAction")
    if action is None:
        return None
    if isinstance(action, pikepdf.Dictionary) and "/D" not in action:
        subtype = action.get("/S")
        if subtype is not None and str(subtype) == "/GoTo":
            return _destination_array(pdf, action.get("/D"))
        return None
    return _destination_array(pdf, action)


def _open_action_is_replaceable(pdf) -> bool:
    """Whether writing a destination /OpenAction would destroy something else.
    Absent, a bare destination, and a /GoTo action are all replaceable; any
    other action dictionary (a /JavaScript open script above all) is not."""
    action = pdf.Root.get("/OpenAction")
    if action is None:
        return True
    if isinstance(action, pikepdf.Array):
        return True
    if isinstance(action, pikepdf.Dictionary):
        if "/D" in action and "/S" not in action:
            return True
        subtype = action.get("/S")
        return subtype is not None and str(subtype) == "/GoTo"
    return isinstance(action, (pikepdf.Name, pikepdf.String))


def _read_zoom(dest) -> tuple[str, float | None]:
    """(zoom mode, percent) from a destination array's fit form."""
    if dest is None or len(dest) < 2:
        return "default", None
    fit = str(dest[1]).lstrip("/")
    if fit == "Fit":
        return "fit-page", None
    if fit in ("FitH", "FitBH"):
        return "fit-width", None
    if fit in ("FitV", "FitBV"):
        return "fit-height", None
    if fit == "FitB":
        return "fit-visible", None
    if fit == "XYZ":
        if len(dest) >= 5:
            raw = dest[4]
            try:
                value = float(raw)
            except (TypeError, ValueError):
                return "default", None
            if value > 0:
                return "percent", round(value * 100, 2)
        return "default", None
    return "default", None


def _viewer_preferences(pdf) -> dict:
    prefs = {key: False for key in _WINDOW_OPTIONS}
    direction = "L2R"
    vp = pdf.Root.get("/ViewerPreferences")
    if vp is None:
        return {**prefs, "direction": direction}
    for panel_key, pdf_key in _WINDOW_OPTIONS.items():
        try:
            prefs[panel_key] = bool(vp.get("/" + pdf_key, False))
        except (TypeError, ValueError, AttributeError):
            prefs[panel_key] = False
    try:
        raw = vp.get("/Direction")
        if raw is not None and str(raw).lstrip("/") == "R2L":
            direction = "R2L"
    except (TypeError, ValueError, AttributeError):
        pass
    return {**prefs, "direction": direction}


def get_initial_view(file: str) -> dict:
    """Read the document's initial view: page layout, page mode, opening page
    and magnification, window options and reading direction.

    Args:
        file: Input PDF path.
    """
    with pikepdf.open(file) as pdf:
        raw_layout = pdf.Root.get("/PageLayout")
        layout = _PAGE_LAYOUTS_INVERSE.get(
            str(raw_layout).lstrip("/") if raw_layout is not None else "", "default"
        )
        raw_mode = pdf.Root.get("/PageMode")
        mode = _PAGE_MODES_INVERSE.get(
            str(raw_mode).lstrip("/") if raw_mode is not None else "", "default"
        )
        dest = _open_action_destination(pdf)
        open_page = None
        if dest is not None and len(dest) >= 1:
            try:
                index = _page_index_of(pdf, dest[0])
            except (TypeError, ValueError, AttributeError):
                index = None
            if index is not None:
                open_page = index + 1
        zoom, zoom_percent = _read_zoom(dest)
        return {
            "file": file,
            "page_layout": layout,
            "page_mode": mode,
            "open_page": open_page,
            "zoom": zoom,
            "zoom_percent": zoom_percent,
            # An /OpenAction this setter would refuse to overwrite. The panel
            # shows the refusal BEFORE the user fills the fields.
            "open_action_replaceable": _open_action_is_replaceable(pdf),
            "pages": len(pdf.pages),
            **_viewer_preferences(pdf),
        }


def _destination_for(page_obj, zoom: str, zoom_percent: float | None) -> Array:
    if zoom == "fit-page":
        return Array([page_obj, Name.Fit])
    if zoom == "fit-width":
        return Array([page_obj, Name.FitH, None])
    if zoom == "fit-height":
        return Array([page_obj, Name.FitV, None])
    if zoom == "fit-visible":
        return Array([page_obj, Name.FitB])
    if zoom == "percent":
        return Array([page_obj, Name.XYZ, None, None, float(zoom_percent) / 100.0])
    # A null in an /XYZ slot leaves that coordinate as the reader found it
    # (ISO 32000 §12.3.2.2), which is what "default magnification" means.
    return Array([page_obj, Name.XYZ, None, None, None])


def _apply_viewer_preferences(pdf, options: dict, direction: str | None) -> None:
    """Write the window options and the direction, deleting on the default so
    the file carries only what departs from it."""
    vp = pdf.Root.get("/ViewerPreferences")
    wanted: dict[str, bool] = {}
    for panel_key, pdf_key in _WINDOW_OPTIONS.items():
        value = options.get(panel_key)
        if value is not None:
            wanted[pdf_key] = bool(value)
    if not wanted and direction is None:
        return
    if vp is None:
        needs_dict = any(wanted.values()) or direction == "R2L"
        if not needs_dict:
            return
        vp = Dictionary()
        pdf.Root[Name.ViewerPreferences] = vp
        vp = pdf.Root["/ViewerPreferences"]
    for pdf_key, value in wanted.items():
        key = "/" + pdf_key
        if value:
            vp[Name(key)] = True
        elif key in vp:
            del vp[key]
    if direction is not None:
        if direction == "R2L":
            vp[Name.Direction] = Name.R2L
        elif "/Direction" in vp:
            del vp["/Direction"]
    if len(vp.keys()) == 0:
        del pdf.Root["/ViewerPreferences"]


def set_initial_view(
    file: str,
    output: str,
    page_layout: str | None = None,
    page_mode: str | None = None,
    open_page: int | None = None,
    zoom: str | None = None,
    zoom_percent: float | None = None,
    hide_toolbar: bool | None = None,
    hide_menubar: bool | None = None,
    hide_window_ui: bool | None = None,
    fit_window: bool | None = None,
    center_window: bool | None = None,
    display_doc_title: bool | None = None,
    direction: str | None = None,
) -> dict:
    """Write the document's initial view. Every argument is None-means-unchanged.

    Args:
        file: Input PDF path.
        output: Output PDF path (may equal `file`).
        page_layout: default | single-page | one-column | two-column-left |
            two-column-right | two-page-left | two-page-right.
        page_mode: default | none | outlines | thumbnails | full-screen | oc |
            attachments.
        open_page: 1-based opening page, or 0 to remove the /OpenAction.
        zoom: default | fit-page | fit-width | fit-height | fit-visible | percent.
        zoom_percent: magnification when `zoom` is 'percent' (1-6400).
        hide_toolbar: /ViewerPreferences /HideToolbar.
        hide_menubar: /ViewerPreferences /HideMenubar.
        hide_window_ui: /ViewerPreferences /HideWindowUI.
        fit_window: /ViewerPreferences /FitWindow.
        center_window: /ViewerPreferences /CenterWindow.
        display_doc_title: /ViewerPreferences /DisplayDocTitle.
        direction: L2R | R2L reading direction.
    """
    if page_layout is not None and page_layout != "default" and page_layout not in _PAGE_LAYOUTS:
        raise ValueError(
            f"page_layout must be 'default' or one of {sorted(_PAGE_LAYOUTS)}, got {page_layout!r}"
        )
    if page_mode is not None and page_mode != "default" and page_mode not in _PAGE_MODES:
        raise ValueError(
            f"page_mode must be 'default' or one of {sorted(_PAGE_MODES)}, got {page_mode!r}"
        )
    if zoom is not None and zoom not in _ZOOM_MODES:
        raise ValueError(f"zoom must be one of {list(_ZOOM_MODES)}, got {zoom!r}")
    if zoom == "percent":
        if zoom_percent is None:
            raise ValueError("zoom 'percent' needs a zoom_percent")
        if not _ZOOM_MIN <= float(zoom_percent) <= _ZOOM_MAX:
            minimum = f"{_ZOOM_MIN:g}"
            maximum = f"{_ZOOM_MAX:g}"
            raise ValueError(
                f"zoom_percent must be between {minimum} and {maximum}, got {zoom_percent!r}"
            )
    if direction is not None and direction not in ("L2R", "R2L"):
        raise ValueError(f"direction must be 'L2R' or 'R2L', got {direction!r}")

    output_path = Path(output)
    with pikepdf.open(file) as pdf:
        total = len(pdf.pages)
        if page_layout is not None:
            if page_layout == "default":
                if "/PageLayout" in pdf.Root:
                    del pdf.Root["/PageLayout"]
            else:
                pdf.Root[Name.PageLayout] = Name("/" + _PAGE_LAYOUTS[page_layout])
        if page_mode is not None:
            if page_mode == "default":
                if "/PageMode" in pdf.Root:
                    del pdf.Root["/PageMode"]
            else:
                pdf.Root[Name.PageMode] = Name("/" + _PAGE_MODES[page_mode])

        if open_page is not None:
            page_number = int(open_page)
            if page_number == 0:
                if "/OpenAction" in pdf.Root:
                    if not _open_action_is_replaceable(pdf):
                        raise ValueError(
                            "the document's open action is a script, not a destination; "
                            "it was left unchanged"
                        )
                    del pdf.Root["/OpenAction"]
            else:
                if page_number < 1 or page_number > total:
                    raise ValueError(f"open_page {page_number} is out of range (1-{total})")
                if not _open_action_is_replaceable(pdf):
                    raise ValueError(
                        "the document's open action is a script, not a destination; "
                        "it was left unchanged"
                    )
                pdf.Root[Name.OpenAction] = _destination_for(
                    pdf.pages[page_number - 1].obj, zoom or "default", zoom_percent
                )

        _apply_viewer_preferences(
            pdf,
            {
                "hide_toolbar": hide_toolbar,
                "hide_menubar": hide_menubar,
                "hide_window_ui": hide_window_ui,
                "fit_window": fit_window,
                "center_window": center_window,
                "display_doc_title": display_doc_title,
            },
            direction,
        )

        # pikepdf cannot save over its own open input (engine/inplace.py).
        if is_same_file(file, output):
            staged = staging_target(output_path)
            save_pdf(pdf, staged)
            finish_staged(staged, output_path)
        else:
            save_pdf(pdf, output_path)

    return {"output": str(output_path)}


# ── Advanced ───────────────────────────────────────────────────────────────


def _is_tagged(pdf) -> bool:
    """The accessibility checker's own definition (`accessibility.py`): the
    marked flag AND a structure tree. Either alone is not a tagged PDF."""
    root = pdf.Root
    mark_info = root.get("/MarkInfo")
    marked = False
    if mark_info is not None:
        try:
            marked = bool(mark_info.get("/Marked"))
        except (TypeError, ValueError, AttributeError):
            marked = False
    return marked and root.get("/StructTreeRoot") is not None


def _page_sizes(pdf) -> list[dict]:
    """Distinct page sizes with their counts, in points, largest group first.
    The CROP box, which is what a reader displays, and rotation is applied: a
    rotated page presents its swapped dimensions, which is the size seen."""
    groups: dict[tuple[float, float], int] = {}
    for page in pdf.pages:
        try:
            box = [float(v) for v in page.cropbox]
            width = round(abs(box[2] - box[0]), 2)
            height = round(abs(box[3] - box[1]), 2)
            rotate = int(page.obj.get("/Rotate", 0) or 0) % 360
        except (TypeError, ValueError, AttributeError, IndexError):
            continue
        if rotate in (90, 270):
            width, height = height, width
        groups[(width, height)] = groups.get((width, height), 0) + 1
    return [
        {"width": w, "height": h, "count": n}
        for (w, h), n in sorted(groups.items(), key=lambda kv: (-kv[1], kv[0]))
    ]


def _search_index(pdf) -> str | None:
    """The full-text index a producer recorded in the catalog's /PieceInfo
    private data. No key is standardized for it, so this is a scan of that
    dict's string values for a .pdx name — a found name is reported, and
    nothing found is reported as nothing RECORDED, never as no index existing."""
    piece_info = pdf.Root.get("/PieceInfo")
    if piece_info is None:
        return None
    found: list[str] = []

    def walk(node, depth: int) -> None:
        if depth > 6 or found:
            return
        if isinstance(node, pikepdf.Dictionary):
            for value in node.values():
                walk(value, depth + 1)
        elif isinstance(node, pikepdf.Array):
            for value in node:
                walk(value, depth + 1)
        elif isinstance(node, pikepdf.String):
            text = str(node)
            if text.lower().endswith(".pdx"):
                found.append(text)

    try:
        walk(piece_info, 0)
    except (TypeError, ValueError, AttributeError, RuntimeError):
        return None
    return found[0] if found else None


def get_advanced_properties(file: str) -> dict:
    """Read the Advanced tab's facts: version, fast web view, tagged status,
    page sizes, the trapped flag, the base URL, and whether an open action and
    a search index are recorded.

    Args:
        file: Input PDF path.
    """
    size = Path(file).stat().st_size
    with pikepdf.open(file) as pdf:
        trapped = "unknown"
        raw_trapped = pdf.trailer.get("/Info", {}).get("/Trapped") if "/Info" in pdf.trailer else None
        if raw_trapped is not None:
            trapped = _TRAPPED_INVERSE.get(str(raw_trapped).lstrip("/"), "unknown")
        base_url = ""
        uri = pdf.Root.get("/URI")
        if uri is not None:
            raw_base = uri.get("/Base")
            if raw_base is not None:
                base_url = str(raw_base)
        return {
            "file": file,
            "version": pdf.pdf_version,
            "linearized": bool(pdf.is_linearized),
            "tagged": _is_tagged(pdf),
            "pages": len(pdf.pages),
            "page_sizes": _page_sizes(pdf),
            "bytes": size,
            "trapped": trapped,
            "base_url": base_url,
            "has_open_action": "/OpenAction" in pdf.Root,
            "search_index": _search_index(pdf),
        }


def set_advanced_properties(
    file: str,
    output: str,
    trapped: str | None = None,
    base_url: str | None = None,
) -> dict:
    """Write the trapped flag and the base URL. None means unchanged.

    Args:
        file: Input PDF path.
        output: Output PDF path (may equal `file`).
        trapped: true | false | unknown.
        base_url: The /Root /URI /Base relative-URI base; empty removes it.
    """
    if trapped is not None and trapped not in _TRAPPED:
        raise ValueError(f"trapped must be one of {sorted(_TRAPPED)}, got {trapped!r}")

    output_path = Path(output)
    with pikepdf.open(file) as pdf:
        if trapped is not None:
            # `docinfo` materializes the trailer's /Info dict when the file has
            # none, which is the only way a trapped flag can land on a document
            # that carries no document information at all.
            pdf.docinfo[Name.Trapped] = Name("/" + _TRAPPED[trapped])
        if base_url is not None:
            text = str(base_url).strip()
            if text:
                pdf.Root[Name.URI] = Dictionary(Base=String(text))
            elif "/URI" in pdf.Root:
                del pdf.Root["/URI"]

        # pikepdf cannot save over its own open input (engine/inplace.py).
        if is_same_file(file, output):
            staged = staging_target(output_path)
            save_pdf(pdf, staged)
            finish_staged(staged, output_path)
        else:
            save_pdf(pdf, output_path)

    return {"output": str(output_path)}
