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
"""

import pikepdf
from pikepdf import Name

_MAX_DEPTH = 12


def _noop(*_args):
    return None


def walk_page_resources(
    page,
    *,
    on_font=_noop,
    on_colorspace=_noop,
    on_image=_noop,
    on_transparency=_noop,
) -> None:
    """Visit everything one page can paint through.

    Page `/Resources` and nested Form XObjects, plus `/Pattern` (a tiling
    pattern's own resources, a shading pattern's shading), `/Shading`, image
    `/ColorSpace`, and annotation appearance streams. A colorant reached only
    through a pattern or an image is still a colorant on the plate, so the
    walk must reach all of them.

    `on_colorspace(cs, category)` carries the route the space was reached by —
    one of `content`, `image`, `shading`, `pattern`, `annotation`. Every
    callback is guarded: a malformed object skips its branch instead of
    sinking the walk.
    """
    seen: set = set()

    def mark(obj) -> bool:
        """False when this object has already been visited on this page."""
        ident = obj.objgen if getattr(obj, "is_indirect", False) else id(obj)
        if ident in seen:
            return False
        seen.add(ident)
        return True

    def visit_shading(sh, depth):
        if sh is None or depth > _MAX_DEPTH:
            return
        try:
            cs = sh.get("/ColorSpace")
        except Exception:
            return
        if cs is not None:
            try:
                on_colorspace(cs, "shading")
            except Exception:
                pass

    def visit_pattern(pat, depth, origin):
        if pat is None or depth > _MAX_DEPTH:
            return
        try:
            ptype = int(pat.get("/PatternType") or 1)
        except (TypeError, ValueError):
            ptype = 1
        if ptype == 2:
            try:
                sh = pat.get("/Shading")
            except Exception:
                sh = None
            if sh is not None:
                visit_shading(sh, depth + 1)
            return
        try:
            res = pat.get("/Resources")
        except Exception:
            res = None
        visit_res(res, depth + 1, origin)

    def visit_res(res, depth, origin):
        if res is None or depth > _MAX_DEPTH:
            return
        fonts = res.get("/Font")
        if fonts is not None:
            for key in list(fonts.keys()):
                try:
                    on_font(fonts[key])
                except Exception:
                    pass
        cs = res.get("/ColorSpace")
        if cs is not None:
            for key in list(cs.keys()):
                try:
                    on_colorspace(cs[key], origin)
                except Exception:
                    pass
        sh = res.get("/Shading")
        if sh is not None:
            for key in list(sh.keys()):
                try:
                    visit_shading(sh[key], depth)
                except Exception:
                    continue
        pat = res.get("/Pattern")
        if pat is not None:
            for key in list(pat.keys()):
                try:
                    obj = pat[key]
                    if not mark(obj):
                        continue
                    visit_pattern(obj, depth, origin)
                except Exception:
                    continue
        xo = res.get("/XObject")
        if xo is not None:
            for key in list(xo.keys()):
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
                            except Exception:
                                pass
                    elif sub == "/Form":
                        grp = obj.get("/Group")
                        if grp is not None and str(grp.get("/S")) == "/Transparency":
                            on_transparency()
                        visit_res(obj.get("/Resources"), depth + 1, origin)
                except Exception:
                    continue
        eg = res.get("/ExtGState")
        if eg is not None:
            for key in list(eg.keys()):
                try:
                    gs = eg[key]
                    ca = gs.get("/ca")
                    caa = gs.get("/CA")
                    if (ca is not None and float(ca) < 1.0) or (caa is not None and float(caa) < 1.0):
                        on_transparency()
                    if gs.get("/SMask") is not None and str(gs.get("/SMask")) != "/None":
                        on_transparency()
                except Exception:
                    continue

    visit_res(page.obj.get("/Resources"), 0, "content")

    try:
        annots = page.obj.get("/Annots")
    except Exception:
        annots = None
    if annots is not None:
        for annot in list(annots):
            try:
                ap = annot.get("/AP")
                if ap is None:
                    continue
                for ap_key in list(ap.keys()):
                    entry = ap[ap_key]
                    streams = [entry]
                    if not isinstance(entry, pikepdf.Stream):
                        streams = [entry[k] for k in list(entry.keys())]
                    for stream in streams:
                        if not mark(stream):
                            continue
                        visit_res(stream.get("/Resources"), 1, "annotation")
            except Exception:
                continue


def _walk_resources(pdf, on_font, on_colorspace, on_image, on_transparency):
    for page in pdf.pages:
        walk_page_resources(
            page,
            on_font=on_font,
            on_colorspace=lambda cs, _category: on_colorspace(cs),
            on_image=on_image,
            on_transparency=on_transparency,
        )


def _font_embedded(font) -> bool:
    """A font is embedded if it (or its descendants) carry a FontFile stream."""
    try:
        subtype = str(font.get("/Subtype"))
    except Exception:
        return True  # can't tell — don't cry wolf
    if subtype == "/Type0":
        desc = font.get("/DescendantFonts")
        if desc is not None:
            try:
                for df in desc:
                    fd = df.get("/FontDescriptor")
                    if fd is not None and _has_fontfile(fd):
                        return True
            except Exception:
                pass
        return False
    if subtype == "/Type3":
        return True  # glyphs are drawn inline — always "embedded"
    fd = font.get("/FontDescriptor")
    return _has_fontfile(fd) if fd is not None else False


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


def preflight(file: str) -> dict:
    checks = []

    def add(cid, label, status, detail):
        checks.append({"id": cid, "label": label, "status": status, "detail": detail})

    non_embedded: list[str] = []
    color_families: set[str] = set()
    image_count = [0]
    has_transparency = [False]

    def on_font(font):
        if not _font_embedded(font):
            name = _font_name(font)
            if name not in non_embedded:
                non_embedded.append(name)

    def on_colorspace(cs):
        try:
            if isinstance(cs, pikepdf.Name):
                color_families.add(str(cs).lstrip("/"))
            elif isinstance(cs, pikepdf.Array) and len(cs) > 0:
                color_families.add(str(cs[0]).lstrip("/"))
        except Exception:
            pass

    def on_image(_img):
        image_count[0] += 1

    def on_transparency():
        has_transparency[0] = True

    # A hairline is a print-readiness failure no proof shows: it renders fine
    # on screen and at 600 dpi, then breaks up or disappears on a 2400 dpi
    # imagesetter. Preflight reports it; Fix Hairlines is what raises it. The
    # measurement runs on its own open, before this one, so the two walks
    # never share a handle.
    from engine.hairlines import DEFAULT_THRESHOLD_PT, hairline_check

    hairlines = hairline_check(file)

    with pikepdf.open(file) as pdf:
        encrypted = pdf.is_encrypted
        _walk_resources(pdf, on_font, on_colorspace, on_image, on_transparency)

        add(
            "fonts_embedded", "All fonts are embedded",
            "pass" if not non_embedded else "fail",
            "Every font is embedded." if not non_embedded
            else "Not embedded (a printer may substitute these): " + ", ".join(sorted(non_embedded)),
        )

        rgb = "DeviceRGB" in color_families or "CalRGB" in color_families
        add(
            "rgb_color", "No RGB colour (press jobs want CMYK/spot)",
            "warn" if rgb else "pass",
            "RGB colour is present — convert to CMYK for offset printing." if rgb
            else "No RGB colour space detected.",
        )

        add(
            "transparency", "No live transparency",
            "warn" if has_transparency[0] else "pass",
            "Live transparency is present — some RIPs need it flattened." if has_transparency[0]
            else "No transparency detected.",
        )

        add(
            "hairlines", "No hairline strokes",
            "warn" if hairlines["count"] else "pass",
            f"{hairlines['count']} stroke(s) are thinner than "
            f"{DEFAULT_THRESHOLD_PT} pt on the device." if hairlines["count"]
            else f"No stroke is thinner than {DEFAULT_THRESHOLD_PT} pt on the device.",
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
        "total": len(checks),
        "images": image_count[0],
        "color_families": sorted(color_families),
    }
