"""Preflight — print-production checks (§ I.6, § I.3).

A read-only report of the print-readiness issues Acrobat's Preflight surfaces:
are all fonts embedded, what colour spaces are used (RGB in a press job is a
red flag), is there live transparency, and is the document encrypted in a way
that blocks printing. It REPORTS; the Convert-to-CMYK / grayscale / optimize
tools do the fixing.

Font and colour-space discovery walks page /Resources AND nested Form XObject
/Resources (bounded depth), so a font used only inside a form is still found.
"""

import pikepdf
from pikepdf import Name

_MAX_DEPTH = 12


def _walk_resources(pdf, on_font, on_colorspace, on_image, on_transparency):
    seen: set = set()

    def visit_res(res, depth):
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
                    on_colorspace(cs[key])
                except Exception:
                    pass
        xo = res.get("/XObject")
        if xo is not None:
            for key in list(xo.keys()):
                try:
                    obj = xo[key]
                    ident = obj.objgen if getattr(obj, "is_indirect", False) else id(obj)
                    if ident in seen:
                        continue
                    seen.add(ident)
                    sub = str(obj.get("/Subtype"))
                    if sub == "/Image":
                        on_image(obj)
                    elif sub == "/Form":
                        grp = obj.get("/Group")
                        if grp is not None and str(grp.get("/S")) == "/Transparency":
                            on_transparency()
                        visit_res(obj.get("/Resources"), depth + 1)
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

    for page in pdf.pages:
        visit_res(page.obj.get("/Resources"), 0)


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
