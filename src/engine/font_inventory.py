"""Every font a document uses — the Properties dialog's Fonts tab.

Read-only enumeration. A font reaches the page through several resource
dictionaries, and a listing that only looked at ``page /Resources /Font`` would
miss most of the interesting ones: a logo's Form XObject keeps its own
resources, a Type3 glyph procedure keeps its own, an annotation's appearance
stream keeps its own, and a form's default appearance fonts live in
``/AcroForm /DR /Font``. All of them are walked.

What is reported per font: the name (subset prefix stripped for display), the
type, the encoding, whether the program is EMBEDDED, and — when it is known to
be absent — the face this app would actually substitute. That last field is
answered by ``font_fallback.resolve_fallback_font``, the resolver every emitter
in this engine already uses, so the tab names the face the app really draws
with rather than guessing at some other reader's system font.

``embedded`` is the shared tri-state (``font_embedding.font_embedded``): true,
false, or null where the font will not read. A null carries no substitution,
because the face a reader would fall back to is only knowable once the program
is known to be missing.
"""

import pikepdf

from .font_embedding import font_embedded
from .font_fallback import classify_font_style, style_key
from .pdf_fonts import _strip_subset_prefix

# Resource dictionaries nest (a form inside a form inside a page). Real
# documents are shallow; the cap stops a cyclic /Resources from walking
# forever, and the visited set stops a shared one from being walked twice.
_MAX_DEPTH = 8


def _font_type(font_obj) -> str:
    """The font's type as the tab names it. A /Type0 reports its DESCENDANT's
    CIDFont type, which is the fact that decides how its program is stored."""
    subtype = str(font_obj.get("/Subtype", "")).lstrip("/")
    if subtype != "Type0":
        return subtype or "Unknown"
    for descendant in _descendants(font_obj):
        child = str(descendant.get("/Subtype", "")).lstrip("/")
        if child:
            return child
    return "Type0"


def _descendants(font_obj) -> list:
    """The /DescendantFonts entries, tolerating the malformed shapes
    `font_fallback._descriptors_of` already documents (a plain dict, or an
    array holding a non-dict)."""
    raw = font_obj.get("/DescendantFonts")
    if raw is None:
        return []
    out = []
    try:
        for entry in raw:
            if isinstance(entry, pikepdf.Dictionary):
                out.append(entry)
    except (TypeError, ValueError, AttributeError):
        if isinstance(raw, pikepdf.Dictionary):
            out.append(raw)
    return out


def _encoding_name(font_obj) -> str:
    """The encoding as the tab names it: a predefined name verbatim, a
    /Differences dictionary as 'Custom', a base encoding named inside such a
    dictionary as that name, and nothing at all as 'Built-in'."""
    encoding = font_obj.get("/Encoding")
    if encoding is None:
        return "Built-in"
    if isinstance(encoding, pikepdf.Dictionary):
        base = encoding.get("/BaseEncoding")
        if encoding.get("/Differences") is not None:
            return "Custom"
        if base is not None:
            return str(base).lstrip("/")
        return "Custom"
    if isinstance(encoding, pikepdf.Stream):
        # An embedded CMap stream — named by its own /CMapName when it has one.
        try:
            name = encoding.get("/CMapName")
        except (TypeError, ValueError, AttributeError):
            name = None
        return str(name).lstrip("/") if name is not None else "Embedded CMap"
    return str(encoding).lstrip("/")


def _substitute_face(font_obj, font_dir: str | None) -> str | None:
    """The face this app would embed for a font whose program is absent, as a
    bare file name. None when no fonts directory was supplied — an unknown
    substitution is reported as unknown, never invented."""
    if not font_dir:
        return None
    from os.path import basename

    from .font_fallback import resolve_fallback_font

    bold, italic = classify_font_style(font_obj)
    try:
        resolved = resolve_fallback_font(font_dir, font_obj, style=style_key(bold, italic))
    except (ValueError, OSError):
        return None
    return basename(resolved)


def _noop(*_args) -> None:
    return None


def _walk_fonts(resources, page_number: int, seen_resources: set, on_font,
                on_unreadable, depth: int) -> None:
    """Walk one resource dictionary, handing every font dictionary it reaches
    to `on_font(font_obj, page_number, resource_name)` and descending into the
    nested resources of its Form XObjects, patterns and Type3 glyph
    procedures.

    The listing, the checker and the embedder share this traversal rather than
    each keeping one: a font reachable by one and not the other would be a
    font one report names and the others cannot see.

    A branch that will not read is REPORTED through
    `on_unreadable(page_number, resource_name, detail)` rather than skipped,
    because a caller that treats a skipped branch as "nothing there" turns
    "I could not look" into a total. `resource_name` names the font entry
    where the unreadable thing is one font, and is None where a whole table
    is at stake.
    """
    if resources is None or depth > _MAX_DEPTH:
        return
    if not isinstance(resources, pikepdf.Dictionary):
        on_unreadable(page_number, None, "a resource entry is not a dictionary")
        return
    try:
        marker = resources.objgen
    except AttributeError:
        marker = None
    if marker is not None and marker != (0, 0):
        key = (marker, page_number)
        if key in seen_resources:
            return
        seen_resources.add(key)

    fonts = resources.get("/Font")
    if fonts is not None and not isinstance(fonts, pikepdf.Dictionary):
        on_unreadable(page_number, None, "the /Font resources are not a dictionary")
    if isinstance(fonts, pikepdf.Dictionary):
        try:
            named = list(fonts.items())
        except Exception as exc:
            on_unreadable(page_number, None,
                          f"the /Font resources will not read: {exc}")
            named = []
        for resource_name, font_obj in named:
            if not isinstance(font_obj, pikepdf.Dictionary):
                on_unreadable(page_number, str(resource_name),
                              "the font resource is not a font dictionary")
                continue
            on_font(font_obj, page_number, str(resource_name))
            char_procs = font_obj.get("/CharProcs")
            if isinstance(char_procs, pikepdf.Dictionary):
                for proc in char_procs.values():
                    _walk_fonts(
                        _stream_resources(proc), page_number, seen_resources,
                        on_font, on_unreadable, depth + 1,
                    )
            _walk_fonts(
                font_obj.get("/Resources"), page_number, seen_resources,
                on_font, on_unreadable, depth + 1,
            )

    xobjects = resources.get("/XObject")
    if isinstance(xobjects, pikepdf.Dictionary):
        for xobj in xobjects.values():
            _walk_fonts(
                _stream_resources(xobj), page_number, seen_resources, on_font,
                on_unreadable, depth + 1,
            )

    patterns = resources.get("/Pattern")
    if isinstance(patterns, pikepdf.Dictionary):
        for pattern in patterns.values():
            _walk_fonts(
                _stream_resources(pattern), page_number, seen_resources, on_font,
                on_unreadable, depth + 1,
            )


def _stream_resources(obj):
    try:
        return obj.get("/Resources")
    except (TypeError, ValueError, AttributeError):
        return None


def _record(font_obj, page_number: int, out: dict, font_dir: str | None) -> None:
    """Fold one font into the grouped result. Identity is (raw name, type,
    encoding, embedded) — one font referenced from forty pages is one row."""
    raw_name = str(font_obj.get("/BaseFont", "")).lstrip("/")
    font_type = _font_type(font_obj)
    encoding = _encoding_name(font_obj)
    embedded = font_embedded(font_obj)
    key = (raw_name, font_type, encoding, embedded)
    entry = out.get(key)
    if entry is None:
        name = _strip_subset_prefix(raw_name) if raw_name else ""
        entry = {
            "name": name,
            "raw_name": raw_name,
            "type": font_type,
            "encoding": encoding,
            "embedded": embedded,
            "subset": bool(raw_name) and name != raw_name,
            "substitute": (
                _substitute_face(font_obj, font_dir) if embedded is False else None
            ),
            "pages": [],
        }
        out[key] = entry
    if page_number > 0 and page_number not in entry["pages"]:
        entry["pages"].append(page_number)


def list_document_fonts(file: str, font_dir: str | None = None) -> dict:
    """Enumerate every font the document uses.

    Args:
        file: Input PDF path.
        font_dir: The vendored fallback-fonts directory. When given, a
            non-embedded font reports the face this app would substitute.
    """
    out: dict = {}
    with pikepdf.open(file) as pdf:
        walk_document_fonts(
            pdf,
            lambda font_obj, page, _name: _record(font_obj, page, out, font_dir),
        )

    fonts = sorted(
        out.values(), key=lambda f: (f["name"].lower(), f["type"], f["encoding"])
    )
    for entry in fonts:
        entry["pages"].sort()
        entry["page_count"] = len(entry["pages"])
    return {"file": file, "fonts": fonts, "count": len(fonts)}


def _walk_annotation_fonts(annotations, page_number: int, seen_resources: set,
                           on_font, on_unreadable) -> None:
    """An annotation's appearance streams carry their own resources — a
    freetext note's font is only ever reachable this way."""
    try:
        entries = list(annotations)
    except (TypeError, ValueError, AttributeError) as exc:
        on_unreadable(page_number, None, f"the annotations will not read: {exc}")
        return
    for annotation in entries:
        if not isinstance(annotation, pikepdf.Dictionary):
            continue
        appearance = annotation.get("/AP")
        if not isinstance(appearance, pikepdf.Dictionary):
            continue
        for state in appearance.values():
            if isinstance(state, pikepdf.Dictionary):
                # An /N whose value is a dictionary of appearance STATES (a
                # checkbox's /Off and /Yes) rather than a single stream.
                for nested in state.values():
                    _walk_fonts(
                        _stream_resources(nested), page_number, seen_resources,
                        on_font, on_unreadable, 1,
                    )
            else:
                _walk_fonts(
                    _stream_resources(state), page_number, seen_resources,
                    on_font, on_unreadable, 1,
                )


def walk_document_fonts(pdf, on_font, on_unreadable=_noop) -> None:
    """Every font dictionary an open document reaches, once per page it is on.

    Page resources, nested forms, patterns, Type3 glyph procedures, annotation
    appearance streams and ``/AcroForm /DR /Font`` — page 0 means "used by the
    document, not by a page", which is where a default-appearance font lives.

    A count taken from anything narrower than this walk is a subset: a font
    reached only through one of those five indirections is still a font the
    document draws with.
    """
    seen_resources: set = set()
    for index, page in enumerate(pdf.pages):
        # Inheritance-aware: /Resources may sit on an ancestor page-tree node,
        # and pikepdf's Page.resources walks up for it.
        try:
            resources = page.resources
        except (AttributeError, KeyError):
            resources = page.obj.get("/Resources")
        except Exception as exc:
            on_unreadable(index + 1, None, f"the page resources will not read: {exc}")
            continue
        _walk_fonts(resources, index + 1, seen_resources, on_font, on_unreadable, 0)
        try:
            annotations = page.obj.get("/Annots")
        except Exception as exc:
            on_unreadable(index + 1, None, f"the annotations will not read: {exc}")
            continue
        if annotations is not None:
            _walk_annotation_fonts(
                annotations, index + 1, seen_resources, on_font, on_unreadable
            )
    try:
        acroform = pdf.Root.get("/AcroForm")
    except Exception as exc:
        on_unreadable(0, None, f"the interactive form will not read: {exc}")
        return
    if isinstance(acroform, pikepdf.Dictionary):
        _walk_fonts(acroform.get("/DR"), 0, seen_resources, on_font, on_unreadable, 0)
