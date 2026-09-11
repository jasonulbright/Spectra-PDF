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

import re
import math
from decimal import Decimal
from pathlib import Path

import pikepdf
from pikepdf import Array, Dictionary, Name, String

from .inplace import staged_write
from engine.incremental import signature_policy, signed_edit_decision
from engine.pdf_save import save_pdf
from engine.pdf_version import version_facts


def _save(pdf, file: str, output_path: Path, **kwargs) -> None:
    """Every write stages beside the destination and swaps the directory
    entry, so a failed write leaves any existing file whole. The Pdf is closed
    inside the block because the destination cannot be replaced while it is
    held open."""
    with staged_write(output_path) as staged:
        save_pdf(pdf, staged, **kwargs)
        pdf.close()


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


class _UnreadableProperty(ValueError):
    """Absence is a fact; an unreadable value is not its default."""


def _dictionary(value):
    if not isinstance(value, pikepdf.Dictionary):
        raise _UnreadableProperty
    return value


def _enum_name(value, choices, default):
    if value is None:
        return default
    if not isinstance(value, pikepdf.Name) or str(value)[1:] not in choices:
        raise _UnreadableProperty
    return choices[str(value)[1:]]


def _number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float, Decimal)):
        raise _UnreadableProperty
    result = float(value)
    if not math.isfinite(result):
        raise _UnreadableProperty
    return result


def _pdf_text(value):
    if not isinstance(value, pikepdf.String):
        raise _UnreadableProperty
    raw = bytes(value)
    for bom, encoding in ((b'\xfe\xff', 'utf-16-be'), (b'\xff\xfe', 'utf-16-le'),
                          (b'\xef\xbb\xbf', 'utf-8')):
        if raw.startswith(bom):
            return raw[len(bom):].decode(encoding, 'strict')
    text = str(value)
    if '\ufffd' in text:
        raise _UnreadableProperty
    return text


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
    """Resolve a byte-string/name identity without repair, stripping or cycles.

    ISO 32000-2 12.3.2.4: name objects use the legacy dictionary; strings
    use the name tree. A slash IN a string is part of its identity.
    """
    if isinstance(name, pikepdf.Name):
        legacy = pdf.Root.get('/Dests')
        return None if legacy is None else _dictionary(legacy).get(str(name))
    if not isinstance(name, pikepdf.String):
        raise _UnreadableProperty
    names = pdf.Root.get('/Names')
    if names is None:
        return None
    tree = _dictionary(names).get('/Dests')
    if tree is None:
        return None
    target, found, keys, seen = bytes(name), None, set(), set()
    stack, count, text_bytes = [(tree, 0)], 0, 0
    while stack:
        node, depth = stack.pop()
        count += 1
        if count > 10000 or depth > 64:
            raise _UnreadableProperty
        _dictionary(node)
        identity = node.objgen
        if identity != (0, 0):
            if identity in seen:
                raise _UnreadableProperty
            seen.add(identity)
        entries, kids = node.get('/Names'), node.get('/Kids')
        if (entries is None) == (kids is None):
            raise _UnreadableProperty
        if kids is not None:
            if not isinstance(kids, Array) or len(kids) + len(stack) > 10000:
                raise _UnreadableProperty
            stack.extend((child, depth + 1) for child in kids)
        else:
            if not isinstance(entries, Array) or len(entries) % 2 or len(entries) > 20000:
                raise _UnreadableProperty
            for i in range(0, len(entries), 2):
                key = entries[i]
                if not isinstance(key, String):
                    raise _UnreadableProperty
                raw = bytes(key)
                text_bytes += len(raw)
                if raw in keys or len(keys) >= 10000 or text_bytes > 2_000_000:
                    raise _UnreadableProperty
                keys.add(raw)
                if raw == target:
                    found = entries[i + 1]
    return found


def _destination_array(pdf, dest):
    """Normalize a destination to its ARRAY form. A destination dictionary
    keeps the array under /D; a name/string destination is looked up."""
    if isinstance(dest, pikepdf.Array):
        result = dest
    elif isinstance(dest, (pikepdf.Name, pikepdf.String)):
        resolved = _resolve_named_destination(pdf, dest)
        result = resolved.get('/D') if isinstance(resolved, Dictionary) else resolved
    elif isinstance(dest, Dictionary):
        result = dest.get('/D')
    else:
        raise _UnreadableProperty
    if not isinstance(result, Array) or len(result) < 2 or not isinstance(result[1], Name):
        raise _UnreadableProperty
    lengths = {'/XYZ': 5, '/Fit': 2, '/FitH': 3, '/FitV': 3, '/FitR': 6,
               '/FitB': 2, '/FitBH': 3, '/FitBV': 3}
    fit = str(result[1])
    if lengths.get(fit) != len(result) or _page_index_of(pdf, result[0]) is None:
        raise _UnreadableProperty
    for value in list(result)[2:]:
        if value is None and fit != '/FitR':
            continue
        _number(value)
    if fit == '/XYZ' and result[4] is not None and _number(result[4]) < 0:
        raise _UnreadableProperty
    return result


def _open_action_destination(pdf):
    """The /OpenAction as a destination ARRAY, or None. An /OpenAction that is
    an ACTION dictionary is a destination only when it is a /GoTo carrying
    one — a /JavaScript open script is not."""
    action = pdf.Root.get("/OpenAction")
    if action is None:
        return None
    if isinstance(action, pikepdf.Dictionary):
        subtype = action.get("/S")
        if not isinstance(subtype, Name):
            raise _UnreadableProperty
        if subtype == Name.GoTo:
            if action.get('/SD') is not None:
                raise _UnreadableProperty
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
        _destination_array(pdf, action)
        return True
    if isinstance(action, pikepdf.Dictionary):
        subtype = action.get("/S")
        if subtype != Name.GoTo or action.get('/SD') is not None:
            return False
        _destination_array(pdf, action.get('/D'))
        return True
    if isinstance(action, (pikepdf.Name, pikepdf.String)):
        _destination_array(pdf, action)
        return True
    raise _UnreadableProperty


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
                return "percent", value * 100
        return "default", None
    if fit == 'FitR':
        return 'custom', None
    return "default", None


def _opening_action_copy(pdf, action):
    """Own the opening /Next graph without changing other users of it.

    Preserve shared/cyclic action identities inside this chain, while a
    link pointing at the original action keeps its original destination.
    Opaque non-Next entries retain their exact existing references.
    """
    clones, originals, pending = {}, {}, []
    references = 0

    def clone(node):
        nonlocal references
        references += 1
        if references > 10000:
            raise _UnreadableProperty
        _dictionary(node)
        if not isinstance(node.get('/S'), Name):
            raise _UnreadableProperty
        identity = node.objgen if node.objgen != (0, 0) else id(node)
        if identity not in clones:
            if len(clones) >= 10000:
                raise _UnreadableProperty
            copies = Dictionary({key: value for key, value in node.items() if key != '/Next'})
            clones[identity] = pdf.make_indirect(copies)
            # Direct dictionaries have no PDF object number. Keep their Python
            # wrappers alive until the whole traversal ends: id reuse must not
            # merge distinct later actions into an already copied action.
            originals[identity] = node
            pending.append((node, clones[identity]))
        return clones[identity]

    result = clone(action)
    while pending:
        original, copied = pending.pop()
        following = original.get('/Next')
        if following is None:
            continue
        if isinstance(following, Array):
            if len(following) > 10000:
                raise _UnreadableProperty
            copied.Next = Array([clone(child) for child in following])
        else:
            copied.Next = clone(following)
    return result


def _viewer_preferences(pdf) -> dict:
    prefs = {key: False for key in _WINDOW_OPTIONS}
    direction = "L2R"
    vp = pdf.Root.get("/ViewerPreferences")
    if vp is None:
        return {**prefs, "direction": direction}
    _dictionary(vp)
    for panel_key, pdf_key in _WINDOW_OPTIONS.items():
        raw = vp.get('/' + pdf_key)
        if raw is not None and not isinstance(raw, bool):
            raise _UnreadableProperty
        prefs[panel_key] = False if raw is None else raw
    direction = _enum_name(vp.get('/Direction'), {'L2R': 'L2R', 'R2L': 'R2L'}, 'L2R')
    return {**prefs, "direction": direction}


def _get_initial_view(file: str) -> dict:
    """Read the document's initial view: page layout, page mode, opening page
    and magnification, window options and reading direction.

    Args:
        file: Input PDF path.
    """
    with pikepdf.open(file) as pdf:
        raw_layout = pdf.Root.get("/PageLayout")
        layout = _enum_name(raw_layout, _PAGE_LAYOUTS_INVERSE, 'default')
        raw_mode = pdf.Root.get("/PageMode")
        mode = _enum_name(raw_mode, _PAGE_MODES_INVERSE, 'default')
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


def get_initial_view(file: str) -> dict:
    """Read a complete initial-view model, never a fabricated edit baseline."""
    try:
        return _get_initial_view(file)
    except (ValueError, TypeError, AttributeError, IndexError, KeyError, RuntimeError, pikepdf.PdfError):
        raise ValueError("The document's initial view cannot be read completely.") from None


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
            if not isinstance(value, bool):
                raise ValueError("Initial-view window options must be booleans.")
            wanted[pdf_key] = value
    if not wanted and direction is None:
        return
    if vp is None:
        needs_dict = any(wanted.values()) or direction == "R2L"
        if not needs_dict:
            return
        vp = Dictionary()
        pdf.Root[Name.ViewerPreferences] = vp
        vp = pdf.Root["/ViewerPreferences"]
    try:
        _dictionary(vp)
    except _UnreadableProperty:
        raise ValueError("The document's initial view cannot be read completely.") from None
    # The catalog may share this dictionary with other consumers. Own only
    # the edited preferences, preserving every unrelated entry/reference.
    vp = Dictionary(vp)
    pdf.Root.ViewerPreferences = vp
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
        try:
            valid_percent = _ZOOM_MIN <= _number(zoom_percent) <= _ZOOM_MAX
        except _UnreadableProperty:
            valid_percent = False
        if not valid_percent:
            minimum = f"{_ZOOM_MIN:g}"
            maximum = f"{_ZOOM_MAX:g}"
            raise ValueError(
                f"zoom_percent must be between {minimum} and {maximum}, got {zoom_percent!r}"
            )
    if direction is not None and direction not in ("L2R", "R2L"):
        raise ValueError(f"direction must be 'L2R' or 'R2L', got {direction!r}")
    if open_page is not None and (not isinstance(open_page, int) or isinstance(open_page, bool)):
        raise ValueError("The opening page must be an integer.")

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

        if open_page is not None or zoom is not None:
            try:
                previous = _open_action_destination(pdf)
                action = pdf.Root.get('/OpenAction')
                replaceable = _open_action_is_replaceable(pdf)
            except _UnreadableProperty:
                replaceable = False
            if not replaceable:
                raise ValueError(
                    "The document's opening action cannot be changed without losing behavior."
                )
            page_number = open_page
            if page_number is None:
                if previous is None:
                    raise ValueError("Choose an opening page before changing its magnification.")
                page_number = _page_index_of(pdf, previous[0]) + 1
            if page_number == 0:
                if "/OpenAction" in pdf.Root:
                    if isinstance(action, Dictionary) and '/Next' in action:
                        raise ValueError(
                            "The document's opening action cannot be changed without losing behavior."
                        )
                    del pdf.Root["/OpenAction"]
            else:
                if page_number < 1 or page_number > total:
                    raise ValueError(f"open_page {page_number} is out of range (1-{total})")
                page = pdf.pages[page_number - 1].obj
                if zoom is None and previous is not None:
                    destination = Array([page, *list(previous)[1:]])
                else:
                    destination = _destination_for(page, zoom or 'default', zoom_percent)
                    if (previous is not None and previous[1] == Name.XYZ
                            and destination[1] == Name.XYZ):
                        destination[2], destination[3] = previous[2], previous[3]
                if isinstance(action, Dictionary):
                    try:
                        owned = _opening_action_copy(pdf, action)
                    except _UnreadableProperty:
                        raise ValueError(
                            "The document's opening action cannot be changed without losing behavior."
                        ) from None
                    owned.D = destination
                    pdf.Root.OpenAction = owned
                else:
                    pdf.Root.OpenAction = destination

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

        _save(pdf, file, output_path)

    return {"output": str(output_path)}


# ── accessibility: the document's language and each page's tab order ───────

# RFC 5646 well-formedness, subtag by subtag. Validity against the IANA
# registry is deliberately NOT checked: the registry is a moving list and a
# tag this refuses is a tag a reader would have honoured.
_PRIMARY = re.compile(r"^[A-Za-z]{2,8}$")
_SCRIPT = re.compile(r"^[A-Za-z]{4}$")
_REGION = re.compile(r"^([A-Za-z]{2}|[0-9]{3})$")
_VARIANT = re.compile(r"^([A-Za-z0-9]{5,8}|[0-9][A-Za-z0-9]{3})$")
_EXTLANG = re.compile(r"^[A-Za-z]{3}$")
_SINGLETON = re.compile(r"^[A-Za-z0-9]$")
_SUBTAG_CHARS = re.compile(r"^[A-Za-z0-9]+$")


def validate_language_tag(tag: str) -> str:
    """The tag, stripped, or a ValueError naming what is wrong with it.

    A language tag names a pronunciation, so a malformed one is worse than an
    absent one: a reader falls back to its own language for an absent /Lang and
    mispronounces the whole document for a tag it half-understands.

    Every message here is a LITERAL at its raise site — a refusal that
    interpolated its own English explanation would re-emit that English inside
    every translated sentence, which is the defect `printer.parse_page_spec`
    already paid for once.
    """
    text = str(tag or "").strip()
    if not text:
        raise ValueError("Name the language, for example en-GB.")
    parts = text.split("-")
    for part in parts:
        if not part:
            raise ValueError(
                f'"{text}" is not a well-formed language tag: it has an empty subtag '
                "(two hyphens in a row, or a hyphen at an end)."
            )
        if not _SUBTAG_CHARS.match(part):
            raise ValueError(
                f'"{text}" is not a well-formed language tag: the subtag "{part}" '
                "may contain only letters and digits."
            )
        # Every subtag a language tag can carry is at most eight characters,
        # so one length test covers the primary, the variants and the
        # private-use section alike.
        if len(part) > 8:
            raise ValueError(
                f'"{text}" is not a well-formed language tag: the subtag "{part}" '
                "is longer than eight characters."
            )
    head = parts[0]
    if head.lower() == "x":
        # A private-use tag stands alone: x- followed by its own subtags.
        if len(parts) < 2:
            raise ValueError(
                f'"{text}" is not a well-formed language tag: "x-" needs at least one '
                "private-use subtag after it."
            )
        return text
    if not _PRIMARY.match(head):
        raise ValueError(
            f'"{text}" is not a well-formed language tag: the language subtag "{head}" '
            "must be two to eight letters, as in en, de or haw."
        )
    rest = parts[1:]
    at = 0
    # Up to three extended-language subtags follow a two- or three-letter
    # primary subtag (zh-cmn-Hans-CN). A three-letter alphabetic subtag in this
    # position can be nothing else: a script is four letters, a region is two
    # letters or three digits, and a variant is five or more.
    if len(head) <= 3:
        extlangs = 0
        while at < len(rest) and extlangs < 3 and _EXTLANG.match(rest[at]):
            at += 1
            extlangs += 1
    if at < len(rest) and _SCRIPT.match(rest[at]):
        at += 1
    if at < len(rest) and _REGION.match(rest[at]):
        at += 1
    while at < len(rest) and _VARIANT.match(rest[at]):
        at += 1
    while at < len(rest) and _SINGLETON.match(rest[at]) and rest[at].lower() != "x":
        singleton = rest[at]
        at += 1
        seen = 0
        while at < len(rest) and 2 <= len(rest[at]) <= 8:
            at += 1
            seen += 1
        if seen == 0:
            raise ValueError(
                f'"{text}" is not a well-formed language tag: the extension '
                f'"{singleton}" carries no subtag.'
            )
    if at < len(rest) and rest[at].lower() == "x":
        at += 1
        if at >= len(rest):
            raise ValueError(
                f'"{text}" is not a well-formed language tag: "x-" needs at least one '
                "private-use subtag after it."
            )
        at = len(rest)
    if at != len(rest):
        raise ValueError(
            f'"{text}" is not a well-formed language tag: the subtag "{rest[at]}" is not '
            "in a position a language tag allows."
        )
    return text


def _signed_structural_gate(file: str, allow_signed: bool) -> str:
    """``proceed`` | ``refuse`` | ``warn`` for a structural edit of `file`.

    The DECISION is shared; the SENTENCE is not. Each door raises its own
    literal message naming its own action, because a refusal that interpolated
    that action would insert an English phrase into every translated sentence
    (`printer.parse_page_spec`, and the standing rule it produced).
    """
    decision = signed_edit_decision(signature_policy(file), "structural")
    if decision.get("reason") == "signature-policy-unreadable":
        from engine.docmdp import refuse_unreadable_policy
        refuse_unreadable_policy()
    if decision["kind"] == "refuse":
        return "refuse"
    if decision["kind"] == "warn" and not allow_signed:
        return "warn"
    return "proceed"


def set_document_language(
    file: str, output: str, lang: str = "", allow_signed: bool = False
) -> dict:
    """Write the catalog's ``/Lang`` — the document's primary language.

    Args:
        file: Input PDF path.
        output: Output PDF path (may equal `file`).
        lang: A BCP 47 language tag (en, en-GB, zh-Hant-TW). Empty removes the
            declaration.
        allow_signed: The signed-document decision, already taken by the caller.
    """
    text = str(lang or "").strip()
    if text:
        text = validate_language_tag(text)
    gate = _signed_structural_gate(file, allow_signed)
    if gate == "refuse":
        raise RuntimeError(
            "this document is certified to allow no changes, so setting the document "
            "language would produce a file that reports as illegally modified"
        )
    if gate == "warn":
        raise RuntimeError(
            "this document is signed and setting the document language invalidates its "
            "signatures -- the run must state that signed documents are included before "
            "it will touch one"
        )

    output_path = Path(output)
    with pikepdf.open(file) as pdf:
        if text:
            pdf.Root[Name.Lang] = String(text)
        elif "/Lang" in pdf.Root:
            del pdf.Root["/Lang"]
        _save(pdf, file, output_path)
    return {"output": str(output_path), "lang": text}


def set_document_title(
    file: str,
    output: str,
    title: str | None = None,
    display: bool | None = None,
    allow_signed: bool = False,
) -> dict:
    """Write the document's title AND whether a reader shows it, in one save.

    The accessibility check they answer is ONE check — a document has a title
    and shows it, or it does not — so the fix is one act and one undo step. The
    title lands through the XMP writer, which is what keeps `dc:title` and the
    document information dictionary saying the same thing; the flag is the
    ordinary `/ViewerPreferences /DisplayDocTitle`, deleted when false so the
    file carries only what departs from the default.

    Args:
        file: Input PDF path.
        output: Output PDF path (may equal `file`).
        title: The document title. None leaves it unchanged.
        display: Whether the reader shows the title instead of the file name.
            None leaves it unchanged.
        allow_signed: The signed-document decision, already taken by the caller.
    """
    if title is None and display is None:
        raise ValueError("no title and no display setting to write")
    gate = _signed_structural_gate(file, allow_signed)
    if gate == "refuse":
        raise RuntimeError(
            "this document is certified to allow no changes, so setting the document "
            "title would produce a file that reports as illegally modified"
        )
    if gate == "warn":
        raise RuntimeError(
            "this document is signed and setting the document title invalidates its "
            "signatures -- the run must state that signed documents are included before "
            "it will touch one"
        )

    output_path = Path(output)
    with pikepdf.open(file) as pdf:
        if title is not None:
            from .metadata import apply_metadata_fields
            apply_metadata_fields(pdf, title=str(title))
        if display is not None:
            _apply_viewer_preferences(pdf, {"display_doc_title": bool(display)}, None)
        _save(pdf, file, output_path, fix_metadata_version=False)
    return {"output": str(output_path), "title": title, "display_doc_title": display}


def set_page_tab_order(
    file: str, output: str, pages=None, order: str = "S", allow_signed: bool = False
) -> dict:
    """Write each page's ``/Tabs`` — the order keyboard focus visits its
    annotations.

    Only pages that CARRY annotations are written. ``/Tabs`` on a page with
    nothing to order is a key that says nothing, and a run that wrote it
    everywhere would report a success it did not earn — so a document with no
    annotations at all refuses instead.

    Args:
        file: Input PDF path.
        output: Output PDF path (may equal `file`).
        pages: 1-based page numbers to write, or None for every page carrying
            annotations.
        order: S (structure order), R (row order) or C (column order).
        allow_signed: The signed-document decision, already taken by the caller.
    """
    value = str(order or "S").strip().lstrip("/").upper()
    if value not in ("S", "R", "C"):
        raise ValueError(f"tab order must be S, R or C, got {order!r}")
    gate = _signed_structural_gate(file, allow_signed)
    if gate == "refuse":
        raise RuntimeError(
            "this document is certified to allow no changes, so setting the tab order "
            "would produce a file that reports as illegally modified"
        )
    if gate == "warn":
        raise RuntimeError(
            "this document is signed and setting the tab order invalidates its "
            "signatures -- the run must state that signed documents are included before "
            "it will touch one"
        )

    output_path = Path(output)
    with pikepdf.open(file) as pdf:
        total = len(pdf.pages)
        wanted = None
        if pages is not None:
            wanted = set()
            for raw in pages:
                # `page_no` and the inline bound are the refusal table's own
                # shape for this message — sixteen modules share one row, and
                # renaming a local here renames its placeholders everywhere.
                page_no = int(raw)
                if not 1 <= page_no <= total:
                    raise ValueError(f"page {page_no} is out of range (1-{len(pdf.pages)})")
                wanted.add(page_no)
        written = []
        skipped = 0
        for i, page in enumerate(pdf.pages):
            number = i + 1
            if wanted is not None and number not in wanted:
                continue
            annots = page.obj.get("/Annots")
            has_annots = False
            if annots is not None:
                try:
                    has_annots = len(annots) > 0
                except (TypeError, ValueError):
                    has_annots = False
            if not has_annots:
                skipped += 1
                continue
            page.obj[Name.Tabs] = Name("/" + value)
            written.append(number)
        if not written:
            raise ValueError(
                "No page here carries an annotation, so there is no tab order to "
                "declare: /Tabs on a page with nothing to order says nothing."
            )
        _save(pdf, file, output_path)
    return {"output": str(output_path), "pages": written, "skipped": skipped, "order": value}


# ── Advanced ───────────────────────────────────────────────────────────────


def _is_tagged(pdf) -> bool:
    """The accessibility checker's own definition (`accessibility.py`): the
    marked flag AND a structure tree. Either alone is not a tagged PDF."""
    root = pdf.Root
    mark_info = root.get("/MarkInfo")
    marked = False
    if mark_info is not None:
        raw = _dictionary(mark_info).get('/Marked')
        if raw is not None and not isinstance(raw, bool):
            raise _UnreadableProperty
        marked = raw is True
    tree = root.get('/StructTreeRoot')
    if tree is not None:
        _dictionary(tree)
    return marked and tree is not None


def _page_sizes(pdf) -> list[dict]:
    """Distinct page sizes with their counts, in points, largest group first.
    The CROP box, which is what a reader displays, and rotation is applied: a
    rotated page presents its swapped dimensions, which is the size seen."""
    groups: dict[tuple[float, float], int] = {}
    for page in pdf.pages:
        box = [_number(v) for v in page.cropbox]
        media = [_number(v) for v in page.mediabox]
        if len(box) != 4 or len(media) != 4:
            raise _UnreadableProperty
        # CropBox is clipped to MediaBox; UserUnit scales default-user-space
        # coordinates into physical 1/72-inch points (page dictionary).
        left = max(min(box[0], box[2]), min(media[0], media[2]))
        right = min(max(box[0], box[2]), max(media[0], media[2]))
        bottom = max(min(box[1], box[3]), min(media[1], media[3]))
        top = min(max(box[1], box[3]), max(media[1], media[3]))
        unit = _number(page.obj.get('/UserUnit', 1))
        if unit <= 0 or right < left or top < bottom:
            raise _UnreadableProperty
        width = round(_number((right - left) * unit), 2)
        height = round(_number((top - bottom) * unit), 2)
        node, rotation, seen = page.obj, None, set()
        for _ in range(65):
            _dictionary(node)
            identity = node.objgen
            if identity != (0, 0):
                if identity in seen:
                    raise _UnreadableProperty
                seen.add(identity)
            rotation = node.get('/Rotate')
            if rotation is not None or '/Parent' not in node:
                break
            node = node.Parent
        else:
            raise _UnreadableProperty
        rotation = 0 if rotation is None else rotation
        if not isinstance(rotation, int) or isinstance(rotation, bool) or rotation % 90:
            raise _UnreadableProperty
        rotate = rotation % 360
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
    _dictionary(piece_info)
    found: list[str] = []
    seen = set()
    stack = [(piece_info, 0)]
    visited = 0
    string_bytes = 0
    while stack:
        node, depth = stack.pop()
        visited += 1
        if visited > 10000 or depth > 64:
            raise _UnreadableProperty
        identity = getattr(node, 'objgen', (0, 0))
        if identity != (0, 0):
            if identity in seen:
                continue
            seen.add(identity)
        if isinstance(node, pikepdf.Dictionary):
            if len(node) + len(stack) > 10000:
                raise _UnreadableProperty
            stack.extend((value, depth + 1) for value in node.values())
        elif isinstance(node, pikepdf.Array):
            if len(node) + len(stack) > 10000:
                raise _UnreadableProperty
            stack.extend((value, depth + 1) for value in node)
        elif isinstance(node, pikepdf.String):
            string_bytes += len(bytes(node))
            if string_bytes > 2 * 1024 * 1024:
                raise _UnreadableProperty
            text = _pdf_text(node)
            if text.lower().endswith(".pdx"):
                found.append(text)
        elif isinstance(node, pikepdf.Stream):
            # Private opaque bytes cannot prove that no index was recorded.
            raise _UnreadableProperty
    if len(set(found)) > 1:
        raise _UnreadableProperty
    return found[0] if found else None


def _get_advanced_properties(file: str) -> dict:
    """Read the Advanced tab's facts: version, fast web view, tagged status,
    page sizes, the trapped flag, the base URL, and whether an open action and
    a search index are recorded.

    Args:
        file: Input PDF path.
    """
    size = Path(file).stat().st_size
    with pikepdf.open(file) as pdf:
        info = pdf.trailer.get('/Info')
        raw_trapped = _dictionary(info).get('/Trapped') if info is not None else None
        trapped = _enum_name(raw_trapped, _TRAPPED_INVERSE, 'unknown')
        base_url = ""
        uri = pdf.Root.get("/URI")
        if uri is not None:
            raw_base = _dictionary(uri).get("/Base")
            if raw_base is not None:
                base_url = _pdf_text(raw_base)
        # The effective declared version, plus the two declarations it
        # came from. A physical header alone is not the document's version
        # when the catalog declares a later one (Table 29).
        facts = version_facts(pdf)
        return {
            "file": file,
            "version": facts["version"],
            "header_version": facts["header_version"],
            "catalog_version": facts["catalog_version"],
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


def get_advanced_properties(file: str) -> dict:
    """Complete facts or a named unreadable result, never partial absence."""
    try:
        return _get_advanced_properties(file)
    except (ValueError, TypeError, AttributeError, IndexError, KeyError, RuntimeError, pikepdf.PdfError):
        raise ValueError("The document's advanced properties cannot be read completely.") from None


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
            if not isinstance(base_url, str):
                raise ValueError("The document base URL must be text.")
            text = base_url.strip()
            previous = pdf.Root.get('/URI')
            uri = Dictionary() if previous is None else Dictionary(_dictionary(previous))
            if text:
                uri.Base = String(text)
            elif '/Base' in uri:
                del uri['/Base']
            if len(uri):
                pdf.Root.URI = uri
            elif '/URI' in pdf.Root:
                del pdf.Root["/URI"]

        _save(pdf, file, output_path)

    return {"output": str(output_path)}
