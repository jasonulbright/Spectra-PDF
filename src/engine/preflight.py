"""Preflight — print-production checks.

A read-only report of print-readiness issues:
are all fonts embedded, what colour spaces are used (RGB in a press job is a
red flag), is there live transparency, and is the document encrypted in a way
that blocks printing. It REPORTS; the Convert-to-CMYK / grayscale / optimize
tools do the fixing.

Font and colour-space discovery walks page /Resources, nested Form XObject
/Resources, patterns, shadings, image colour spaces and annotation appearance
streams (bounded depth), so a font or a colorant used only inside one of those
is still found. `walk_page_resources` is that walk, shared with the separation
inventory.

The hairline row measures effective device stroke widths through
`engine.hairlines`, which owns both the measurement and the correction — the
report and the fix cannot disagree about what a hairline is.

Every check carries a fourth verdict, `needs_review`. A walk that could not
read part of a document has not established that the document is clean, and a
report that turned that into a pass would be the one failure a preflight tool
cannot have. What each skipped branch could have hidden travels with it, so a
skip only clouds the checks that read from it.
"""

import pikepdf
from pikepdf import Name

_MAX_DEPTH = 12

# What a skipped branch could have been hiding. A check whose fact is in the
# hidden set cannot report a pass: it did not look everywhere.
FONT = "font"
COLORSPACE = "colorspace"
IMAGE = "image"
TRANSPARENCY = "transparency"
#: A resource subtree can hold any of the four, so a subtree that will not
#: read hides all of them.
ALL_FACTS = (FONT, COLORSPACE, IMAGE, TRANSPARENCY)


def _noop(*_args):
    return None


def walk_page_resources(
    page,
    *,
    on_font=_noop,
    on_colorspace=_noop,
    on_image=_noop,
    on_transparency=_noop,
    on_unreadable=_noop,
) -> None:
    """Visit everything one page can paint through.

    Page `/Resources` and nested Form XObjects, plus `/Pattern` (a tiling
    pattern's own resources, a shading pattern's shading), `/Shading`, image
    `/ColorSpace`, and annotation appearance streams. A colorant reached only
    through a pattern or an image is still a colorant on the plate, so the
    walk must reach all of them.

    `on_colorspace(cs, category)` carries the route the space was reached by —
    one of `content`, `image`, `shading`, `pattern`, `annotation`.

    A malformed object skips its branch instead of sinking the walk, and every
    skip is REPORTED through `on_unreadable(facts, reason)`: `facts` names
    what that branch could have been hiding, `reason` says what went wrong.
    A caller that treats a skipped branch as "nothing there" turns "I could
    not look" into a passing check, so the channel is not optional detail —
    it is the other half of every answer this walk gives.
    """
    seen: set = set()

    def unreadable(facts, reason) -> None:
        try:
            on_unreadable(tuple(facts), str(reason))
        except Exception:
            pass

    def entries(table, facts, what: str):
        """The names in one resource table, or none with the skip reported.

        A table that is not a dictionary at all is the commonest malformation
        here, and enumerating it raises: unguarded, one broken table sinks the
        whole walk and every check with it.
        """
        try:
            return list(table.keys())
        except Exception as exc:
            unreadable(facts, f"the {what} table will not read: {exc}")
            return ()

    def mark(obj) -> bool:
        """False when this object has already been visited on this page."""
        ident = obj.objgen if getattr(obj, "is_indirect", False) else id(obj)
        if ident in seen:
            return False
        seen.add(ident)
        return True

    def visit_shading(sh, depth):
        if sh is None:
            return
        if depth > _MAX_DEPTH:
            unreadable((COLORSPACE,), f"a shading nests deeper than {_MAX_DEPTH} levels")
            return
        try:
            cs = sh.get("/ColorSpace")
        except Exception as exc:
            unreadable((COLORSPACE,), f"a shading's colour space will not read: {exc}")
            return
        if cs is not None:
            try:
                on_colorspace(cs, "shading")
            except Exception as exc:
                unreadable((COLORSPACE,), f"a shading's colour space will not read: {exc}")

    def visit_pattern(pat, depth, origin):
        if pat is None:
            return
        if depth > _MAX_DEPTH:
            unreadable(ALL_FACTS, f"a pattern nests deeper than {_MAX_DEPTH} levels")
            return
        try:
            ptype = int(pat.get("/PatternType") or 1)
        except (TypeError, ValueError) as exc:
            unreadable(ALL_FACTS, f"a pattern's type will not read: {exc}")
            return
        if ptype == 2:
            try:
                sh = pat.get("/Shading")
            except Exception as exc:
                unreadable((COLORSPACE,), f"a pattern's shading will not read: {exc}")
                return
            if sh is not None:
                visit_shading(sh, depth + 1)
            return
        try:
            res = pat.get("/Resources")
        except Exception as exc:
            unreadable(ALL_FACTS, f"a pattern's resources will not read: {exc}")
            return
        visit_res(res, depth + 1, origin)

    def visit_res(res, depth, origin):
        if res is None:
            return
        if depth > _MAX_DEPTH:
            unreadable(ALL_FACTS, f"resources nest deeper than {_MAX_DEPTH} levels")
            return
        try:
            fonts = res.get("/Font")
        except Exception as exc:
            unreadable(ALL_FACTS, f"a resource dictionary will not read: {exc}")
            return
        if fonts is not None:
            for key in entries(fonts, (FONT,), "/Font"):
                try:
                    on_font(fonts[key])
                except Exception as exc:
                    unreadable((FONT,), f"a font will not read: {exc}")
        cs = res.get("/ColorSpace")
        if cs is not None:
            for key in entries(cs, (COLORSPACE,), "/ColorSpace"):
                try:
                    on_colorspace(cs[key], origin)
                except Exception as exc:
                    unreadable((COLORSPACE,), f"a colour space will not read: {exc}")
        sh = res.get("/Shading")
        if sh is not None:
            for key in entries(sh, (COLORSPACE,), "/Shading"):
                try:
                    visit_shading(sh[key], depth)
                except Exception as exc:
                    unreadable((COLORSPACE,), f"a shading will not read: {exc}")
                    continue
        pat = res.get("/Pattern")
        if pat is not None:
            for key in entries(pat, ALL_FACTS, "/Pattern"):
                try:
                    obj = pat[key]
                    if not mark(obj):
                        continue
                    visit_pattern(obj, depth, origin)
                except Exception as exc:
                    unreadable(ALL_FACTS, f"a pattern will not read: {exc}")
                    continue
        xo = res.get("/XObject")
        if xo is not None:
            for key in entries(xo, ALL_FACTS, "/XObject"):
                try:
                    obj = xo[key]
                    if not mark(obj):
                        continue
                    sub = str(obj.get("/Subtype"))
                    if sub == "/Image":
                        on_image(obj)
                        img_cs = obj.get("/ColorSpace")
                        if img_cs is not None:
                            try:
                                on_colorspace(img_cs, "image")
                            except Exception as exc:
                                unreadable(
                                    (COLORSPACE,),
                                    f"an image's colour space will not read: {exc}",
                                )
                    elif sub == "/Form":
                        grp = obj.get("/Group")
                        if grp is not None and str(grp.get("/S")) == "/Transparency":
                            on_transparency()
                        visit_res(obj.get("/Resources"), depth + 1, origin)
                except Exception as exc:
                    unreadable(ALL_FACTS, f"an XObject will not read: {exc}")
                    continue
        eg = res.get("/ExtGState")
        if eg is not None:
            for key in entries(eg, (TRANSPARENCY,), "/ExtGState"):
                try:
                    gs = eg[key]
                    ca = gs.get("/ca")
                    caa = gs.get("/CA")
                    if (ca is not None and float(ca) < 1.0) or (caa is not None and float(caa) < 1.0):
                        on_transparency()
                    if gs.get("/SMask") is not None and str(gs.get("/SMask")) != "/None":
                        on_transparency()
                except Exception as exc:
                    unreadable((TRANSPARENCY,), f"a graphics state will not read: {exc}")
                    continue

    try:
        own = page.obj.get("/Resources")
    except Exception as exc:
        unreadable(ALL_FACTS, f"the page's resources will not read: {exc}")
        own = None
    visit_res(own, 0, "content")

    try:
        annots = page.obj.get("/Annots")
    except Exception as exc:
        unreadable(ALL_FACTS, f"the page's annotations will not read: {exc}")
        annots = None
    if annots is not None:
        for annot in list(annots):
            try:
                ap = annot.get("/AP")
                if ap is None:
                    continue
                for ap_key in entries(ap, ALL_FACTS, "/AP"):
                    entry = ap[ap_key]
                    streams = [entry]
                    if not isinstance(entry, pikepdf.Stream):
                        streams = [entry[k] for k in list(entry.keys())]
                    for stream in streams:
                        if not mark(stream):
                            continue
                        visit_res(stream.get("/Resources"), 1, "annotation")
            except Exception as exc:
                unreadable(ALL_FACTS, f"an annotation appearance will not read: {exc}")
                continue


def _walk_resources(pdf, on_font, on_colorspace, on_image, on_transparency,
                    on_unreadable=_noop):
    for page in pdf.pages:
        walk_page_resources(
            page,
            on_font=on_font,
            on_colorspace=lambda cs, _category: on_colorspace(cs),
            on_image=on_image,
            on_transparency=on_transparency,
            on_unreadable=on_unreadable,
        )


def _font_embedded(font):
    """True, False, or None when the font will not read.

    None is neither answer. Reporting an unreadable font as embedded is a
    passing check the walk did not earn; reporting it as NOT embedded is a
    false failure on a document that may be conforming. Both are wrong, so
    the caller is handed the third state and reports it.
    """
    try:
        subtype = str(font.get("/Subtype"))
    except Exception:
        return None
    if subtype == "/Type0":
        try:
            desc = font.get("/DescendantFonts")
        except Exception:
            return None
        if desc is None:
            return False
        try:
            for df in desc:
                fd = df.get("/FontDescriptor")
                if fd is not None and _has_fontfile(fd):
                    return True
        except Exception:
            return None
        return False
    if subtype == "/Type3":
        return True  # glyphs are drawn inline — always "embedded"
    try:
        fd = font.get("/FontDescriptor")
    except Exception:
        return None
    if fd is None:
        return False
    try:
        return _has_fontfile(fd)
    except Exception:
        return None


def _has_fontfile(fd) -> bool:
    for k in ("/FontFile", "/FontFile2", "/FontFile3"):
        if fd.get(k) is not None:
            return True
    return False


def _font_name(font) -> str:
    try:
        bf = font.get("/BaseFont")
        return str(bf).lstrip("/") if bf is not None else "(unnamed)"
    except Exception:
        return "(unnamed)"


#: A check that could not look everywhere reports this instead of a pass. It
#: is the accessibility checker's vocabulary, and for the same reason: a check
#: that can be wrong never claims a pass it did not earn.
REVIEW = "needs_review"

_REVIEW_DETAIL_CAP = 3


def preflight(file: str) -> dict:
    """The print-readiness report.

    Every check is one of `pass`, `warn`, `fail` or `needs_review`. A positive
    finding is certain — a non-embedded font found is a non-embedded font — so
    `warn` and `fail` stand whatever else the walk could not read. A CLEAN
    result is only a `pass` when the walk reached everything that check reads
    from; where it did not, the row is `needs_review` and names what it could
    not read. "Could not look" is never reported as "nothing found".
    """
    checks = []

    def add(cid, label, status, detail):
        checks.append({"id": cid, "label": label, "status": status, "detail": detail})

    non_embedded: list[str] = []
    color_families: set[str] = set()
    image_count = [0]
    has_transparency = [False]
    unreadable: list[dict] = []
    hidden: set[str] = set()

    def note(facts, reason: str) -> None:
        hidden.update(facts)
        row = {"reason": reason, "affects": sorted(facts)}
        if row not in unreadable:
            unreadable.append(row)

    def on_font(font):
        embedded = _font_embedded(font)
        name = _font_name(font)
        if embedded is None:
            note((FONT,), f"the font {name} will not read")
            return
        if not embedded and name not in non_embedded:
            non_embedded.append(name)

    def on_colorspace(cs):
        try:
            if isinstance(cs, pikepdf.Name):
                color_families.add(str(cs).lstrip("/"))
            elif isinstance(cs, pikepdf.Array) and len(cs) > 0:
                color_families.add(str(cs[0]).lstrip("/"))
        except Exception as exc:
            note((COLORSPACE,), f"a colour space will not read: {exc}")

    def on_image(_img):
        image_count[0] += 1

    def on_transparency():
        has_transparency[0] = True

    def review_detail(fact: str) -> str:
        reasons = [row["reason"] for row in unreadable if fact in row["affects"]]
        shown = "; ".join(reasons[:_REVIEW_DETAIL_CAP])
        if len(reasons) > _REVIEW_DETAIL_CAP:
            more = len(reasons) - _REVIEW_DETAIL_CAP
            shown = f"{shown}; and {more} more"
        return (
            "Part of this document could not be read, so this check cannot "
            f"report a pass: {shown}"
        )

    # A hairline is a print-readiness failure no proof shows: it renders fine
    # on screen and at 600 dpi, then breaks up or disappears on a 2400 dpi
    # imagesetter. Preflight reports it; Fix Hairlines is what raises it. The
    # measurement runs on its own open, before this one, so the two walks
    # never share a handle.
    from engine.hairlines import DEFAULT_THRESHOLD_PT, hairline_check

    hairlines = hairline_check(file)
    for reason in hairlines["unreadable"]:
        note((), reason)
    hairlines_unreadable = list(hairlines["unreadable"])

    with pikepdf.open(file) as pdf:
        encrypted = pdf.is_encrypted
        _walk_resources(pdf, on_font, on_colorspace, on_image, on_transparency,
                        note)

        if non_embedded:
            add(
                "fonts_embedded", "All fonts are embedded", "fail",
                "Not embedded (a printer may substitute these): "
                + ", ".join(sorted(non_embedded)),
            )
        elif FONT in hidden:
            add("fonts_embedded", "All fonts are embedded", REVIEW,
                review_detail(FONT))
        else:
            add("fonts_embedded", "All fonts are embedded", "pass",
                "Every font is embedded.")

        rgb = "DeviceRGB" in color_families or "CalRGB" in color_families
        if rgb:
            add(
                "rgb_color", "No RGB colour (press jobs want CMYK/spot)", "warn",
                "RGB colour is present — convert to CMYK for offset printing.",
            )
        elif COLORSPACE in hidden:
            add("rgb_color", "No RGB colour (press jobs want CMYK/spot)", REVIEW,
                review_detail(COLORSPACE))
        else:
            add("rgb_color", "No RGB colour (press jobs want CMYK/spot)", "pass",
                "No RGB colour space detected.")

        if has_transparency[0]:
            add(
                "transparency", "No live transparency", "warn",
                "Live transparency is present — some RIPs need it flattened.",
            )
        elif TRANSPARENCY in hidden:
            add("transparency", "No live transparency", REVIEW,
                review_detail(TRANSPARENCY))
        else:
            add("transparency", "No live transparency", "pass",
                "No transparency detected.")

        if hairlines["count"]:
            add(
                "hairlines", "No hairline strokes", "warn",
                f"{hairlines['count']} stroke(s) are thinner than "
                f"{DEFAULT_THRESHOLD_PT} pt on the device.",
            )
        elif hairlines_unreadable:
            shown = "; ".join(hairlines_unreadable[:_REVIEW_DETAIL_CAP])
            add(
                "hairlines", "No hairline strokes", REVIEW,
                "Stroke widths could not be measured everywhere, so this "
                f"check cannot report a pass: {shown}",
            )
        else:
            add(
                "hairlines", "No hairline strokes", "pass",
                f"No stroke is thinner than {DEFAULT_THRESHOLD_PT} pt on the device.",
            )

        add(
            "print_allowed", "Printing is permitted",
            "pass" if not encrypted else "warn",
            "The document is not encrypted." if not encrypted
            else "The document is encrypted — confirm printing is allowed for your workflow.",
        )

    return {
        "checks": checks,
        "passed": sum(1 for c in checks if c["status"] == "pass"),
        "warnings": sum(1 for c in checks if c["status"] == "warn"),
        "failed": sum(1 for c in checks if c["status"] == "fail"),
        "needs_review": sum(1 for c in checks if c["status"] == REVIEW),
        "total": len(checks),
        "images": image_count[0],
        "color_families": sorted(color_families),
        "unreadable": unreadable,
    }
