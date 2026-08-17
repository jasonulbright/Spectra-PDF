"""Preflight — 37 print-production checks across seven categories.

A preflight verdict is meaningless without the rule it was measured against,
so the profile is not a filter over a fixed report: it IS the report's premise.
Every check row carries the parameters it resolved to, which is what makes the
artifact legible a year later by someone who does not have the profile.

Four rules govern the whole inventory, and each one is a bug if dropped.

**Five verdicts, and `pass` is never the fallback.** ``not_applicable`` is a
state of its own, and it carries two different sentences: a document with no
images has nothing to say about image resolution, and a profile that DISABLED
the image checks said so on purpose. Neither is a pass, and both are excluded
from the pass tally.

**Severity is the profile's; the verdict is the document's.** A check decides
clean or dirty; the profile decides whether dirty reads as `fail` or `warn`.
One implementation, nine shipped opinions.

**A check that can be wrong reports ``needs_review``, never ``fail``.** A false
failure on a conforming press file costs a print run. Total area coverage
beyond its stated budget, an overprint over ink no resolver could evaluate, a
resolution figure standing over unmeasurable placements — each is reported
with its inventory so a human reviews a list rather than a document.

**"Could not look" is never "nothing found".** A resource branch that will not
read names what it could have been hiding, and every check whose fact is in
that set degrades to ``needs_review``. A positive finding is still certain: a
non-embedded font found is a non-embedded font, so `warn` and `fail` stand
whatever else the walk could not reach.

Addresses come in three kinds, each matching a jump the app already performs:
``page`` (a box, a size or a coverage figure is about a page, not a thing on
it), ``content`` ({page, rect}) and ``object`` ({page, annotation} · {field} ·
{ink}). An address never outlives the report it was read from, so the report
re-runs on every buffer change.
"""

from __future__ import annotations

import pikepdf
from pikepdf import Name  # noqa: F401  (re-exported for callers of the walk)

from engine.font_embedding import font_embedded
from engine.preflight_profiles import (
    CATEGORIES,
    CHECK_INVENTORY,
    CHECK_PARAMS,
    check_enabled,
    check_severity,
    resolve_profile,
    resolved_params,
)

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
    on_extgstate=_noop,
    on_stream=_noop,
    on_unreadable=_noop,
) -> None:
    """Visit everything one page can paint through.

    Page `/Resources` and nested Form XObjects, plus `/Pattern` (a tiling
    pattern's own resources, a shading pattern's shading), `/Shading`, image
    `/ColorSpace`, and annotation appearance streams. A colorant reached only
    through a pattern or an image is still a colorant on the plate, so the
    walk must reach all of them.

    `on_colorspace(cs, category)` and `on_font(font, category)` carry the
    route the resource was reached by — one of `content`, `image`, `shading`,
    `pattern`, `annotation`. "RGB is present" and "an IMAGE is RGB" are
    different checks in every commercial profile, and a Type 3 font inside an
    appearance stream is not page content; the category is what tells each
    pair apart.

    `on_stream(obj, category)` hands over each content stream — the page's
    own, every form XObject and tiling pattern, every annotation appearance.
    A device colour set by a `g`/`rg`/`k` operator names no resource at all,
    so a caller asking which colour families a page carries reads them here;
    the resource callbacks alone would report a page painted entirely in
    `1 0 0 rg` as carrying no colour space.

    `on_extgstate(gs, category)` hands over each graphics state whole. The
    transparency callback answers the alpha question; overprint is a different
    question about the same dictionary, and a second traversal to ask it would
    drift from this one the moment nothing compared them.

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

    def stream(obj, origin) -> None:
        try:
            on_stream(obj, origin)
        except Exception as exc:
            unreadable((COLORSPACE,), f"a content stream will not read: {exc}")

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
        stream(pat, origin)
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
                    on_font(fonts[key], origin)
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
                        stream(obj, origin)
                        visit_res(obj.get("/Resources"), depth + 1, origin)
                except Exception as exc:
                    unreadable(ALL_FACTS, f"an XObject will not read: {exc}")
                    continue
        eg = res.get("/ExtGState")
        if eg is not None:
            for key in entries(eg, (TRANSPARENCY,), "/ExtGState"):
                try:
                    gs = eg[key]
                    on_extgstate(gs, origin)
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
    stream(page, "content")
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
                    for appearance in streams:
                        if not mark(appearance):
                            continue
                        stream(appearance, "annotation")
                        visit_res(appearance.get("/Resources"), 1, "annotation")
            except Exception as exc:
                unreadable(ALL_FACTS, f"an annotation appearance will not read: {exc}")
                continue


def _font_name(font) -> str:
    try:
        bf = font.get("/BaseFont")
        return str(bf).lstrip("/") if bf is not None else "(unnamed)"
    except Exception:
        return "(unnamed)"


def _font_subtype(font) -> str:
    try:
        return str(font.get("/Subtype") or "").lstrip("/")
    except Exception:
        return ""


PASS = "pass"
FAIL = "fail"
WARN = "warn"
#: A check that could not look everywhere reports this instead of a pass. It
#: is the accessibility checker's vocabulary, and for the same reason: a check
#: that can be wrong never claims a pass it did not earn.
REVIEW = "needs_review"
NA = "not_applicable"

#: A check the profile switched off, as distinct from a check with nothing to
#: check. "Nothing to look at" and "you told me not to look" are not the same
#: sentence, and a report that spelled them the same way would let a disabled
#: rule read as a clean document.
DISABLED_DETAIL = "check_disabled"

_REVIEW_DETAIL_CAP = 3
#: A check can name thousands of runs on a long document. The report carries
#: every one; this only bounds what one check's finding list grows to before
#: the remainder is stated as a number.
_MAX_FINDINGS = 2000


class _Check:
    def __init__(self, cid: str, category: str, severity: str, params: dict):
        self.id = cid
        self.category = category
        self.severity = severity
        self.params = params
        self.status = NA
        self.counted = 0
        self.findings: list = []
        self.data: dict = {}

    def to_json(self) -> dict:
        out = {
            "id": self.id,
            "category": self.category,
            "status": self.status,
            "severity": self.severity,
            "counted": self.counted,
            # The rule this row was measured against, on the row. A verdict
            # with no rule beside it is unreadable a year later.
            "params": self.params,
            "findings": self.findings[:_MAX_FINDINGS],
            "finding_count": len(self.findings),
        }
        if self.data:
            out["data"] = self.data
        return out


def _page_address(page=None) -> dict:
    out: dict = {"kind": "page"}
    if page is not None:
        out["page"] = int(page)
    return out


def _content_address(page: int) -> dict:
    return {"kind": "content", "page": int(page)}


def _object_address(page=None, annotation=None, field=None, ink=None) -> dict:
    out: dict = {"kind": "object"}
    if page is not None:
        out["page"] = int(page)
    if annotation is not None:
        out["annotation"] = int(annotation)
    if field is not None:
        out["field"] = str(field)
    if ink is not None:
        out["ink"] = str(ink)
    return out


def _finding(address: dict, detail_key: str, preview: str = "", rect=None,
             values: dict | None = None) -> dict:
    """One addressed finding. `values` are the measured numbers and names the
    localized detail sentence interpolates — never a rendered sentence, so
    nothing downstream matches on localized text."""
    out = {"address": address, "detail_key": detail_key, "preview": preview}
    if rect is not None:
        out["rect"] = [round(float(v), 2) for v in rect]
    if values:
        out["values"] = values
    return out


def _verdict(check: _Check, counted: int, findings: list, *, none_state=NA,
             clean=PASS, dirty=None) -> None:
    """The document decides clean or dirty; the profile decides what dirty
    reads as."""
    check.counted = counted
    check.findings = findings
    if counted == 0 and not findings:
        check.status = none_state
        return
    check.status = (dirty or check.severity) if findings else clean


def _disabled(check: _Check) -> None:
    check.status = NA
    check.counted = 0
    check.findings = [_finding(_page_address(), DISABLED_DETAIL)]
    check.data = {"na_reason": "disabled"}


# ── the reads ─────────────────────────────────────────────────────────────


def _safe(fn, default):
    """One optional read. A machine that will not answer is reported through
    the check that needed it, never as an exception out of the report: a
    preflight run that raises tells the user nothing about the document."""
    try:
        return fn(), ""
    except Exception as exc:  # noqa: BLE001 — every failure is a report row
        return default, str(exc)


def _version_tuple(text: str) -> tuple:
    try:
        parts = str(text).strip().split(".")
        return tuple(int(p) for p in parts[:2])
    except (TypeError, ValueError):
        return ()


def _family_of(cs) -> str:
    try:
        if isinstance(cs, pikepdf.Name):
            return str(cs).lstrip("/")
        if isinstance(cs, pikepdf.Array) and len(cs) > 0:
            return str(cs[0]).lstrip("/")
    except Exception:
        return ""
    return ""


_ANNOT_PRINT_FLAG = 1 << 2  # /F bit position 3 — "print"


def _annotation_rows(pdf) -> tuple:
    """Every annotation with its page, subtype and whether it PRINTS.

    A non-printing sticky note does not reach the press, so the check reads
    the flag rather than the mere presence of an annotation.
    """
    rows: list = []
    unreadable: list = []
    for index, page in enumerate(pdf.pages, start=1):
        try:
            annots = page.obj.get("/Annots")
        except Exception as exc:
            unreadable.append(f"page {index}: the annotations will not read: {exc}")
            continue
        if annots is None:
            continue
        try:
            listed = list(annots)
        except Exception as exc:
            unreadable.append(f"page {index}: the annotations will not read: {exc}")
            continue
        for ordinal, annot in enumerate(listed):
            try:
                subtype = str(annot.get("/Subtype") or "").lstrip("/")
                flags = int(annot.get("/F") or 0)
            except Exception as exc:
                unreadable.append(
                    f"page {index}: an annotation will not read: {exc}"
                )
                continue
            rows.append({
                "page": index,
                "index": ordinal,
                "subtype": subtype,
                "prints": bool(flags & _ANNOT_PRINT_FLAG),
            })
    return rows, unreadable


def _javascript_sites(pdf) -> list:
    """Every place a document carries JavaScript, not only the catalog name
    tree. F16 measured four sites where the name tree reports one, and a
    profile that forbids scripting has to be told about all of them."""
    sites: list = []

    def note(where: str, obj) -> None:
        try:
            if not isinstance(obj, pikepdf.Dictionary):
                return
            if str(obj.get("/S") or "") == "/JavaScript":
                sites.append(where)
        except Exception:
            return

    def sweep(where: str, holder) -> None:
        try:
            for key in ("/A", "/AA"):
                entry = holder.get(key) if holder is not None else None
                if entry is None:
                    continue
                if str(entry.get("/S") or "") == "/JavaScript":
                    sites.append(where)
                    continue
                for trigger in list(entry.keys()):
                    note(f"{where} {str(trigger).lstrip('/')}", entry[trigger])
        except Exception:
            return

    try:
        names = pdf.Root.get("/Names")
        tree = names.get("/JavaScript") if isinstance(names, pikepdf.Dictionary) else None
        if isinstance(tree, pikepdf.Dictionary):
            for name, action in pikepdf.NameTree(tree).items():
                if isinstance(action, pikepdf.Dictionary):
                    sites.append(str(name))
    except Exception:
        pass
    sweep("document", pdf.Root)
    for index, page in enumerate(pdf.pages, start=1):
        sweep(f"page {index}", page.obj)
        try:
            annots = page.obj.get("/Annots")
            if annots is not None:
                for annot in list(annots):
                    sweep(f"page {index}", annot)
        except Exception:
            continue
    return sorted(set(sites))


# ── the checks ────────────────────────────────────────────────────────────


def _check_pdf_version(check, reads) -> None:
    version = reads["version"]
    if not version:
        check.status = REVIEW
        check.findings = [_finding(_page_address(), "read_failed", values={"reason": ""})]
        return
    findings = []
    maximum = _version_tuple(check.params["max_version"])
    minimum = _version_tuple(check.params["min_version"])
    current = _version_tuple(version)
    if maximum and current and current > maximum:
        findings.append(_finding(
            _page_address(), "version_above_max",
            values={"version": version, "max": check.params["max_version"]},
        ))
    if minimum and current and current < minimum:
        findings.append(_finding(
            _page_address(), "version_below_min",
            values={"version": version, "min": check.params["min_version"]},
        ))
    _verdict(check, 1, findings)


def _check_print_permitted(check, reads) -> None:
    allow = reads["permissions"]
    if allow is None:
        check.status = REVIEW
        check.findings = [_finding(_page_address(), "read_failed", values={"reason": ""})]
        return
    lowres, highres = allow
    if not lowres:
        _verdict(check, 1, [_finding(_page_address(), "print_denied")])
        return
    if not highres:
        # Printing IS permitted; only the high-resolution path is not. That is
        # a lesser fact than a denial and never the profile's own severity.
        _verdict(check, 1, [_finding(_page_address(), "print_highres_denied")],
                 dirty=WARN)
        return
    _verdict(check, 1, [])


def _check_structurally_sound(check, reads) -> None:
    report = reads["structural"]
    if report is None:
        check.status = REVIEW
        check.findings = [_finding(_page_address(), "read_failed",
                                   values={"reason": reads["structural_error"]})]
        return
    findings = [
        _finding(_page_address(), "structural_error",
                 values={"message": str(issue.get("message", ""))})
        for issue in report.get("issues", [])
        if issue.get("severity") == "error"
    ]
    _verdict(check, 1, findings)


def _check_output_intent(check, reads) -> None:
    if not check.params["required"]:
        return
    intents = reads["output_intents"]
    if intents is None:
        check.status = REVIEW
        check.findings = [_finding(_page_address(), "read_failed", values={"reason": ""})]
        return
    if not intents:
        _verdict(check, 1, [_finding(_page_address(), "output_intent_missing")])
        return
    allowed = [str(v) for v in check.params["allowed_identifiers"]]
    findings = []
    for intent in intents:
        identifier = intent["identifier"]
        if allowed and identifier not in allowed:
            findings.append(_finding(
                _page_address(), "output_intent_not_allowed",
                preview=identifier,
                values={"identifier": identifier, "allowed": ", ".join(allowed)},
            ))
        if check.params["require_embedded_profile"] and not intent["embedded"]:
            findings.append(_finding(
                _page_address(), "output_intent_profile_missing",
                preview=identifier, values={"identifier": identifier},
            ))
    _verdict(check, len(intents), findings)


def _check_pdfx_claim(check, reads) -> None:
    expected = str(check.params["expected"])
    if not expected:
        return
    found = reads["pdfx_claim"]
    if found is None:
        check.status = REVIEW
        check.findings = [_finding(_page_address(), "read_failed", values={"reason": ""})]
        return
    if not found:
        _verdict(check, 1, [_finding(_page_address(), "pdfx_claim_missing",
                                     values={"expected": expected})])
        return
    findings = []
    if found != expected:
        findings.append(_finding(
            _page_address(), "pdfx_claim_mismatch", preview=found,
            values={"found": found, "expected": expected},
        ))
    _verdict(check, 1, findings)


def _check_trapped(check, reads) -> None:
    if not check.params["require_declared"]:
        return
    trapped = reads["trapped"]
    accept = [str(v).lower() for v in check.params["accept"]]
    if trapped == "unknown":
        _verdict(check, 1, [_finding(_page_address(), "trapped_undeclared")])
        return
    findings = []
    if accept and str(trapped).lower() not in accept:
        findings.append(_finding(
            _page_address(), "trapped_not_accepted", preview=str(trapped),
            values={"value": str(trapped), "accepted": ", ".join(accept)},
        ))
    _verdict(check, 1, findings)


def _check_embedded_files(check, reads) -> None:
    if check.params["allow"]:
        return
    attachments = reads["attachments"]
    if attachments is None:
        check.status = REVIEW
        check.findings = [_finding(_page_address(), "read_failed", values={"reason": ""})]
        return
    findings = [
        _finding(_object_address(), "embedded_file", preview=entry["name"],
                 values={"name": entry["name"]})
        for entry in attachments
    ]
    _verdict(check, len(attachments), findings, none_state=PASS)


def _check_page_size_consistent(check, reads) -> None:
    sizes = reads["page_sizes"]
    pages = reads["page_count"]
    if pages <= 1 or not sizes:
        return
    tolerance = float(check.params["tolerance_pt"])
    first = sizes[0]
    findings = []
    for entry in sizes[1:]:
        if (abs(entry["width"] - first["width"]) > tolerance
                or abs(entry["height"] - first["height"]) > tolerance):
            findings.append(_finding(
                _page_address(), "page_size_differs",
                values={
                    "width": round(entry["width"], 1),
                    "height": round(entry["height"], 1),
                    "first_width": round(first["width"], 1),
                    "first_height": round(first["height"], 1),
                    "count": entry["count"],
                },
            ))
    _verdict(check, pages, findings)


def _check_page_size_expected(check, reads) -> None:
    width = float(check.params["width_pt"])
    height = float(check.params["height_pt"])
    if width <= 0 or height <= 0:
        return
    tolerance = float(check.params["tolerance_pt"])
    landscape = bool(check.params["allow_landscape"])
    findings = []
    for entry in reads["pages"]:
        w, h = entry["width"], entry["height"]
        upright = abs(w - width) <= tolerance and abs(h - height) <= tolerance
        turned = landscape and abs(w - height) <= tolerance and abs(h - width) <= tolerance
        if not (upright or turned):
            findings.append(_finding(
                _page_address(entry["page"]), "page_size_unexpected",
                values={
                    "page": entry["page"],
                    "width": round(w, 1), "height": round(h, 1),
                    "expected_width": round(width, 1),
                    "expected_height": round(height, 1),
                },
            ))
    _verdict(check, len(reads["pages"]), findings)


def _check_trim_box(check, reads) -> None:
    findings = [
        _finding(_page_address(entry["page"]), "trim_box_missing",
                 values={"page": entry["page"]})
        for entry in reads["pages"] if entry["trim"] is None
    ]
    _verdict(check, len(reads["pages"]), findings)


def _check_bleed(check, reads) -> None:
    required = float(check.params["min_bleed_pt"])
    with_trim = [entry for entry in reads["pages"] if entry["trim"] is not None]
    findings = []
    for entry in with_trim:
        trim = entry["trim"]
        bleed = entry["bleed"] or entry["media"]
        if bleed is None:
            findings.append(_finding(
                _page_address(entry["page"]), "bleed_box_missing",
                values={"page": entry["page"]},
            ))
            continue
        margin = min(
            trim[0] - bleed[0], trim[1] - bleed[1],
            bleed[2] - trim[2], bleed[3] - trim[3],
        )
        if margin + 1e-6 < required:
            findings.append(_finding(
                _page_address(entry["page"]), "bleed_too_small",
                values={
                    "page": entry["page"],
                    "bleed": round(max(margin, 0.0), 2),
                    "required": round(required, 2),
                },
            ))
    _verdict(check, len(with_trim), findings)


def _check_page_count(check, reads) -> None:
    minimum = int(check.params["min_pages"])
    maximum = int(check.params["max_pages"])
    multiple = int(check.params["multiple_of"])
    if not (minimum or maximum or multiple):
        return
    pages = reads["page_count"]
    findings = []
    if minimum and pages < minimum:
        findings.append(_finding(_page_address(), "page_count_below",
                                 values={"pages": pages, "min": minimum}))
    if maximum and pages > maximum:
        findings.append(_finding(_page_address(), "page_count_above",
                                 values={"pages": pages, "max": maximum}))
    if multiple and pages % multiple:
        findings.append(_finding(_page_address(), "page_count_not_multiple",
                                 values={"pages": pages, "multiple": multiple}))
    _verdict(check, 1, findings)


def _colour_findings(uses, forbidden, detail_key) -> list:
    wanted = {str(v) for v in forbidden}
    out = []
    for use in uses:
        if use["family"] in wanted:
            out.append(_finding(
                _page_address(use["page"]), detail_key, preview=use["family"],
                values={
                    "family": use["family"], "page": use["page"],
                    "category": use["category"],
                },
            ))
    return out


def _check_colour_family(check, reads) -> None:
    uses = reads["colour_uses"]
    _verdict(check, len(uses),
             _colour_findings(uses, check.params["forbidden_families"],
                              "forbidden_colour_family"))


def _check_grayscale_only(check, reads) -> None:
    if not check.params["require_grayscale"]:
        return
    grey = {"DeviceGray", "CalGray", "Separation", "DeviceN", "Indexed"}
    uses = reads["colour_uses"]
    findings = [
        _finding(_page_address(use["page"]), "not_grayscale", preview=use["family"],
                 values={"family": use["family"], "page": use["page"]})
        for use in uses if use["family"] not in grey
    ]
    _verdict(check, len(uses), findings)


def _check_device_independent(check, reads) -> None:
    forbidden = check.params["forbidden_families"]
    if not forbidden:
        return
    uses = reads["colour_uses"]
    _verdict(check, len(uses),
             _colour_findings(uses, forbidden, "device_independent_colour"))


def _check_spot_count(check, reads) -> None:
    inks = reads["inks"]
    if inks is None:
        check.status = REVIEW
        check.findings = [_finding(_page_address(), "read_failed",
                                   values={"reason": reads["inks_error"]})]
        return
    spots = [e for e in inks["inks"] if e["kind"] == "spot"]
    if inks["unknown"]:
        # A branch that could hold a colorant was not read, so the plate count
        # is a floor. A floor is not a verdict.
        check.status = REVIEW
        check.counted = len(spots)
        check.findings = [
            _finding(_page_address(), "unreadable_branch", values={"reason": reason})
            for reason in inks["unknown"][:_REVIEW_DETAIL_CAP]
        ]
        return
    maximum = int(check.params["max_spots"])
    findings = []
    if len(spots) > maximum:
        findings.append(_finding(
            _page_address(), "too_many_spots",
            values={"count": len(spots), "max": maximum},
        ))
    _verdict(check, len(spots), findings)


def _check_spot_names(check, reads) -> None:
    allowed = [str(v) for v in check.params["allowed_names"]]
    if not allowed or check.params["allow_unlisted"]:
        return
    inks = reads["inks"]
    if inks is None:
        check.status = REVIEW
        check.findings = [_finding(_page_address(), "read_failed",
                                   values={"reason": reads["inks_error"]})]
        return
    spots = [e for e in inks["inks"] if e["kind"] == "spot"]
    findings = [
        # An ink name is document content and reaches the report verbatim.
        _finding(_object_address(ink=entry["name"]), "spot_not_allowed",
                 preview=entry["name"], values={"name": entry["name"]})
        for entry in spots if entry["name"] not in allowed
    ]
    _verdict(check, len(spots), findings)


def _check_ink_coverage(check, reads) -> None:
    """Total area coverage — the per-pixel maximum, measured, or named.

    The honest measurement is one Ghostscript run per page and there is no
    cheap substitute: the device's own average reports 200 % on a page whose
    true maximum is 340 %, so a sampled figure reported as a pass would be
    exactly the silent wrongness this checker exists to end. The cost is
    therefore STATED — `max_pages` is a budget, pages beyond it report
    `needs_review` BY NAME, and nothing is ever estimated from the pages that
    did run.
    """
    from engine.separations import ink_statistics, render_separations

    limit = float(check.params["max_tac_pct"])
    dpi = int(check.params["sample_dpi"])
    over_area = float(check.params["over_area_pct"])
    budget = int(check.params["max_pages_measured"])
    pages = reads["page_count"]
    if pages == 0:
        return
    measured = min(pages, budget)
    findings: list = []
    reviewed = 0
    for number in range(1, measured + 1):
        try:
            plates = render_separations(
                reads["file"], page=number, dpi=dpi, gs_path=reads["gs_path"],
            )
            stats = ink_statistics(
                [p["file"] for p in plates["plates"]], limit_pct=limit
            )
        except Exception as exc:  # noqa: BLE001
            # A missing optional tool never sinks a report; it is named.
            reviewed += 1
            findings.append(_finding(
                _page_address(number), "tac_not_measured",
                values={"page": number, "reason": str(exc)},
            ))
            continue
        area = stats["over_fraction"] * 100.0
        if stats["max_tac"] > limit + 1e-6 and area > over_area + 1e-9:
            findings.append(_finding(
                _page_address(number), "tac_over_limit",
                values={
                    "page": number,
                    "max_tac": round(stats["max_tac"], 1),
                    "limit": round(limit, 1),
                    "area": round(area, 2),
                },
            ))
    if pages > measured:
        reviewed += 1
        findings.append(_finding(
            _page_address(), "tac_budget_exceeded",
            values={"pages": pages - measured, "budget": budget},
        ))
    check.counted = pages
    check.findings = findings
    real = len(findings) - reviewed
    if real > 0:
        check.status = check.severity
    elif reviewed:
        check.status = REVIEW
    else:
        check.status = PASS


def _check_overprint(check, reads) -> None:
    paints = reads["overprint"]
    if paints is None:
        check.status = REVIEW
        check.findings = [_finding(_page_address(), "read_failed",
                                   values={"reason": reads["overprint_error"]})]
        return
    rows = paints["paints"]
    if not rows and not paints["states"]:
        return
    flag_any = bool(check.params["flag_any"])
    text_white = bool(check.params["flag_white_text"])
    fill_white = bool(check.params["flag_white_fill"])
    findings: list = []
    reviewed = 0
    for row in rows:
        wanted_white = text_white if row["text"] else fill_white
        if row["zero_tint"] is True and wanted_white:
            findings.append(_finding(
                _page_address(row["page"]), "overprint_zero_tint",
                values={"page": row["page"], "channel": row["channel"]},
            ))
            continue
        if row["zero_tint"] is None:
            # An ICC or indexed value the resolver could not evaluate is not
            # knowable, and reporting it as white would fail a correct design.
            reviewed += 1
            findings.append(_finding(
                _page_address(row["page"]), "overprint_unknown_ink",
                values={"page": row["page"], "channel": row["channel"]},
            ))
            continue
        if flag_any:
            findings.append(_finding(
                _page_address(row["page"]), "overprint_present",
                values={"page": row["page"], "channel": row["channel"]},
            ))
    if not rows and paints["states"]:
        reviewed += 1
        findings.append(_finding(
            _page_address(paints["states"][0]["page"]), "overprint_state_unpainted",
            values={"count": len(paints["states"])},
        ))
    check.counted = len(rows) or len(paints["states"])
    check.findings = findings
    real = len(findings) - reviewed
    if real > 0:
        check.status = check.severity
    elif reviewed:
        check.status = REVIEW
    else:
        check.status = PASS


def _check_fonts_embedded(check, reads) -> None:
    pages_of = {
        entry["name"]: entry.get("pages", [])
        for entry in (reads["fonts"] or {}).get("fonts", [])
    }
    findings = [
        _finding(_object_address(), "font_not_embedded", preview=name,
                 values={"name": name,
                         "pages": ", ".join(str(p) for p in pages_of.get(name, []))})
        for name in sorted(reads["non_embedded"])
    ]
    _verdict(check, reads["font_count"], findings, none_state=NA)


def _check_fonts_subset(check, reads) -> None:
    if not check.params["require_subset"]:
        return
    inventory = reads["fonts"]
    if inventory is None:
        check.status = REVIEW
        check.findings = [_finding(_page_address(), "read_failed",
                                   values={"reason": reads["fonts_error"]})]
        return
    embedded = [f for f in inventory["fonts"] if f.get("embedded")]
    findings = [
        _finding(_object_address(), "font_not_subset", preview=f["name"],
                 values={"name": f["name"]})
        for f in embedded if not f.get("subset")
    ]
    _verdict(check, len(embedded), findings)


def _check_type3(check, reads) -> None:
    if check.params["allow_type3"]:
        return
    findings = [
        _finding(_object_address(), "type3_font", preview=name,
                 values={"name": name})
        for name in sorted(reads["type3_fonts"])
    ]
    _verdict(check, reads["font_count"], findings)


def _check_min_type_size(check, reads) -> None:
    runs = reads["text_runs"]
    if runs is None:
        check.status = REVIEW
        check.findings = [_finding(_page_address(), "read_failed",
                                   values={"reason": reads["text_error"]})]
        return
    minimum = float(check.params["min_size_pt"])
    reversed_min = float(check.params["min_size_pt_reversed"])
    findings: list = []
    reviewed = 0
    for run in runs:
        size = float(run["size"])
        if size + 1e-9 < minimum:
            findings.append(_finding(
                _content_address(run["page"]), "type_too_small",
                preview=run["text"][:40], rect=run["rect"],
                values={"page": run["page"], "size": round(size, 2),
                        "minimum": round(minimum, 2)},
            ))
            continue
        if size + 1e-9 >= reversed_min:
            continue
        state = _reversed_state(run)
        if state is True:
            findings.append(_finding(
                _content_address(run["page"]), "type_too_small_reversed",
                preview=run["text"][:40], rect=run["rect"],
                values={"page": run["page"], "size": round(size, 2),
                        "minimum": round(reversed_min, 2)},
            ))
        elif state is None:
            reviewed += 1
            findings.append(_finding(
                _content_address(run["page"]), "type_backdrop_unknown",
                preview=run["text"][:40], rect=run["rect"],
                values={"page": run["page"], "size": round(size, 2)},
            ))
    check.counted = len(runs)
    check.findings = findings
    if not runs:
        check.status = NA
        return
    real = len(findings) - reviewed
    check.status = check.severity if real > 0 else (REVIEW if reviewed else PASS)


def _reversed_state(run):
    """True when the run is light type on a darker backdrop, False when it is
    not, None when the walk could not resolve what it sits on.

    A reversed line breaks up at a size an ordinary one survives, so the
    threshold moves — but only where the backdrop is known. Guessing here
    would fail a page that is correct.
    """
    from engine.contrast import relative_luminance

    ink = run.get("ink")
    background = run.get("background")
    if ink is None or background is None:
        return None
    return relative_luminance(ink) > relative_luminance(background)


def _check_small_text_k_only(check, reads) -> None:
    runs = reads["text_runs"]
    if runs is None:
        check.status = REVIEW
        check.findings = [_finding(_page_address(), "read_failed",
                                   values={"reason": reads["text_error"]})]
        return
    from engine.contrast import relative_luminance
    from engine.overprint import ink_count

    below = float(check.params["applies_below_pt"])
    maximum = int(check.params["max_inks"])
    counted = 0
    findings: list = []
    for run in runs:
        if float(run["size"]) + 1e-9 >= below:
            continue
        ink = run.get("ink")
        if ink is None or relative_luminance(ink) > 0.2:
            continue  # not black type — a different question
        counted += 1
        inks = ink_count(run.get("ink_space", ""), run.get("ink_components"))
        if inks is None or inks <= maximum:
            continue
        findings.append(_finding(
            _content_address(run["page"]), "small_text_multi_ink",
            preview=run["text"][:40], rect=run["rect"],
            values={"page": run["page"], "size": round(float(run["size"]), 2),
                    "inks": inks, "max": maximum},
        ))
    _verdict(check, counted, findings)


def _image_rows(reads, bitonal: bool) -> list:
    return [
        p for p in reads["placements"]
        if (int(p.get("bpc") or 0) == 1) is bitonal
    ]


def _check_image_min_dpi(check, reads, bitonal: bool) -> None:
    if reads["images"] is None:
        check.status = REVIEW
        check.findings = [_finding(_page_address(), "read_failed",
                                   values={"reason": reads["images_error"]})]
        return
    rows = _image_rows(reads, bitonal)
    minimum = int(check.params["min_dpi"])
    key = "image_bitonal_below_min_dpi" if bitonal else "image_below_min_dpi"
    findings = [
        _finding(_object_address(page=p["page"]), key,
                 values={"page": p["page"], "index": p["index"],
                         "dpi": p["dpi"], "minimum": minimum})
        for p in rows if p["dpi"] < minimum
    ]
    _verdict(check, len(rows), findings)
    if check.status == PASS and reads["images"]["unmeasured"]:
        # The figures describe the placements that COULD be measured; a
        # degenerate one is the honest floor, not a clean sheet.
        check.status = REVIEW
        check.findings = [_finding(
            _page_address(), "images_unmeasured",
            values={"count": reads["images"]["unmeasured"]},
        )]


def _check_image_max_dpi(check, reads) -> None:
    maximum = int(check.params["max_dpi"])
    if maximum <= 0:
        return
    if reads["images"] is None:
        check.status = REVIEW
        check.findings = [_finding(_page_address(), "read_failed",
                                   values={"reason": reads["images_error"]})]
        return
    rows = reads["placements"]
    findings = [
        _finding(_object_address(page=p["page"]), "image_above_max_dpi",
                 values={"page": p["page"], "index": p["index"],
                         "dpi": p["dpi"], "maximum": maximum})
        for p in rows if p["dpi"] > maximum
    ]
    _verdict(check, len(rows), findings)


def _check_image_compression(check, reads) -> None:
    forbidden = {str(v) for v in check.params["forbidden_filters"]}
    if not forbidden:
        return
    if reads["images"] is None:
        check.status = REVIEW
        check.findings = [_finding(_page_address(), "read_failed",
                                   values={"reason": reads["images_error"]})]
        return
    rows = reads["placements"]
    findings = []
    for p in rows:
        for used in p.get("filters", ()):
            if used in forbidden:
                findings.append(_finding(
                    _object_address(page=p["page"]), "image_forbidden_filter",
                    preview=used,
                    values={"page": p["page"], "index": p["index"], "filter": used},
                ))
    _verdict(check, len(rows), findings)


def _check_image_colour_space(check, reads) -> None:
    uses = [u for u in reads["colour_uses"] if u["category"] == "image"]
    _verdict(check, len(uses),
             _colour_findings(uses, check.params["forbidden_families"],
                              "image_forbidden_colour_family"))


def _check_transparency(check, reads) -> None:
    findings = [
        _finding(_page_address(page), "live_transparency", values={"page": page})
        for page in sorted(reads["transparent_pages"])
    ]
    _verdict(check, reads["page_count"], findings)


def _check_hairlines(check, reads) -> None:
    report = reads["hairlines"]
    if report is None:
        check.status = REVIEW
        check.findings = [_finding(_page_address(), "read_failed",
                                   values={"reason": reads["hairlines_error"]})]
        return
    threshold = float(check.params["threshold_pt"])
    findings: list = []
    for row in report["pages"]:
        for stroke in row.get("strokes", ()):
            findings.append(_finding(
                _content_address(row["page"]), "hairline_stroke",
                rect=stroke.get("rect"),
                values={"page": row["page"],
                        "width": round(float(stroke.get("effective_pt", 0.0)), 3),
                        "threshold": round(threshold, 3)},
            ))
        for border in row.get("annotations", ()):
            findings.append(_finding(
                _object_address(page=row["page"], annotation=border.get("index", 0)),
                "hairline_border", preview=str(border.get("subtype", "")).lstrip("/"),
                values={"page": row["page"],
                        "width": round(float(border.get("width_pt", 0.0)), 3),
                        "threshold": round(threshold, 3)},
            ))
    _verdict(check, reads["page_count"], findings)
    if not findings and report["unreadable"]:
        check.status = REVIEW
        check.findings = [
            _finding(_page_address(), "unreadable_branch",
                     values={"reason": reason})
            for reason in report["unreadable"][:_REVIEW_DETAIL_CAP]
        ]


def _check_optional_content(check, reads) -> None:
    if check.params["allow_optional_content"]:
        return
    layers = reads["layers"]
    if layers is None:
        check.status = REVIEW
        check.findings = [_finding(_page_address(), "read_failed",
                                   values={"reason": reads["layers_error"]})]
        return
    findings = [
        _finding(_object_address(), "optional_content_layer", preview=layer["name"],
                 values={"name": layer["name"]})
        for layer in layers
    ]
    _verdict(check, len(layers), findings, none_state=PASS)


def _check_printing_annotations(check, reads) -> None:
    rows = reads["annotations"]
    forbidden = {str(v).lstrip("/") for v in check.params["forbidden_subtypes"]}
    printing_only = bool(check.params["printing_only"])
    considered = [
        row for row in rows
        if (not printing_only or row["prints"])
        and (not forbidden or row["subtype"] in forbidden)
        and row["subtype"] not in ("Link", "Widget", "Popup")
    ]
    findings = [
        _finding(_object_address(page=row["page"], annotation=row["index"]),
                 "printing_annotation", preview=row["subtype"],
                 values={"page": row["page"], "subtype": row["subtype"]})
        for row in considered
    ]
    _verdict(check, len(rows), findings, none_state=PASS)


def _check_interactive_form(check, reads) -> None:
    if check.params["allow_forms"]:
        return
    fields = reads["fields"]
    if fields is None:
        check.status = REVIEW
        check.findings = [_finding(_page_address(), "read_failed",
                                   values={"reason": reads["fields_error"]})]
        return
    findings = [
        _finding(_object_address(field=f["name"]), "form_field", preview=f["name"],
                 values={"name": f["name"], "type": f["type"]})
        for f in fields
    ]
    _verdict(check, len(fields), findings, none_state=PASS)


def _check_title(check, reads) -> None:
    if not check.params["require_title"]:
        return
    title = reads["title"]
    findings = [] if title.strip() else [_finding(_page_address(), "title_missing")]
    _verdict(check, 1, findings)


def _check_document_javascript(check, reads) -> None:
    if check.params["allow_js"]:
        return
    sites = reads["javascript"]
    findings = [
        _finding(_object_address(), "document_javascript", preview=site,
                 values={"name": site})
        for site in sites
    ]
    _verdict(check, 1, findings)


def _check_xmp(check, reads) -> None:
    if not check.params["require_xmp"]:
        return
    findings = [] if reads["has_xmp"] else [_finding(_page_address(), "xmp_missing")]
    _verdict(check, 1, findings)


#: Which fact each check reads from, for the fail-closed pass. A check whose
#: fact is in the hidden set did not look everywhere and cannot claim a pass.
_READS_FACT = {
    "colour_family": COLORSPACE,
    "grayscale_only": COLORSPACE,
    "device_independent_colour": COLORSPACE,
    "spot_ink_count": COLORSPACE,
    "spot_ink_names": COLORSPACE,
    "image_colour_space": COLORSPACE,
    "fonts_embedded": FONT,
    "fonts_subset": FONT,
    "type3_fonts": FONT,
    "live_transparency": TRANSPARENCY,
    "image_min_dpi_contone": IMAGE,
    "image_min_dpi_bitonal": IMAGE,
    "image_max_dpi": IMAGE,
    "image_compression": IMAGE,
}

_RUNNERS = {
    "pdf_version": _check_pdf_version,
    "print_permitted": _check_print_permitted,
    "structurally_sound": _check_structurally_sound,
    "output_intent": _check_output_intent,
    "pdfx_claim": _check_pdfx_claim,
    "trapped_declared": _check_trapped,
    "embedded_files": _check_embedded_files,
    "page_size_consistent": _check_page_size_consistent,
    "page_size_expected": _check_page_size_expected,
    "trim_box": _check_trim_box,
    "bleed_sufficient": _check_bleed,
    "page_count": _check_page_count,
    "colour_family": _check_colour_family,
    "grayscale_only": _check_grayscale_only,
    "device_independent_colour": _check_device_independent,
    "spot_ink_count": _check_spot_count,
    "spot_ink_names": _check_spot_names,
    "ink_coverage_max": _check_ink_coverage,
    "overprint": _check_overprint,
    "fonts_embedded": _check_fonts_embedded,
    "fonts_subset": _check_fonts_subset,
    "type3_fonts": _check_type3,
    "min_type_size": _check_min_type_size,
    "small_text_k_only": _check_small_text_k_only,
    "image_min_dpi_contone": lambda c, r: _check_image_min_dpi(c, r, False),
    "image_min_dpi_bitonal": lambda c, r: _check_image_min_dpi(c, r, True),
    "image_max_dpi": _check_image_max_dpi,
    "image_compression": _check_image_compression,
    "image_colour_space": _check_image_colour_space,
    "live_transparency": _check_transparency,
    "hairlines_absent": _check_hairlines,
    "optional_content": _check_optional_content,
    "printing_annotations": _check_printing_annotations,
    "interactive_form": _check_interactive_form,
    "title_present": _check_title,
    "document_javascript": _check_document_javascript,
    "xmp_present": _check_xmp,
}


def _gather(file: str, profile: dict, gs_path: str, font_dir) -> dict:
    """Every fact the inventory reads, gathered once.

    Reads that only one disabled check would consume are not performed: a
    profile that switched a check off did not ask for the cost of answering
    it. Nothing else changes with the profile — the same document read the
    same way always gives the same facts.
    """
    from engine.attachments import list_attachments
    from engine.check import check as structural_check
    from engine.contrast import document_contrast
    from engine.doc_properties import get_advanced_properties
    from engine.font_inventory import list_document_fonts, walk_document_fonts
    from engine.forms import read_form_fields
    from engine.image_resolution import summarize_image_resolution
    from engine.layers import list_layers
    from engine.overprint import list_overprint
    from engine.page_boxes import effective_box
    from engine.separations import list_inks

    wanted = {cid for cid in _RUNNERS if check_enabled(profile, cid)}

    reads: dict = {"file": file, "gs_path": gs_path}
    unreadable: list = []
    hidden: set = set()

    def note(facts, reason: str) -> None:
        hidden.update(facts)
        row = {"reason": reason, "affects": sorted(facts)}
        if row not in unreadable:
            unreadable.append(row)

    non_embedded: list[str] = []
    type3: list[str] = []
    colour_uses: list[dict] = []
    transparent_pages: set = set()
    font_names: set = set()
    seen_colour: set = set()

    def note_embedding(font) -> None:
        embedded = font_embedded(font)
        name = _font_name(font)
        font_names.add(name)
        if embedded is None:
            note((FONT,), f"the font {name} will not read")
            return
        if not embedded and name not in non_embedded:
            non_embedded.append(name)

    with pikepdf.open(file) as pdf:
        reads["version"] = str(pdf.pdf_version)
        try:
            reads["permissions"] = (bool(pdf.allow.print_lowres),
                                    bool(pdf.allow.print_highres))
        except Exception:
            reads["permissions"] = None
        pages: list = []
        for number, page in enumerate(pdf.pages, start=1):
            media = effective_box(page, "/MediaBox")
            crop = effective_box(page, "/CropBox") or media
            pages.append({
                "page": number,
                "media": media,
                "crop": crop,
                "trim": effective_box(page, "/TrimBox"),
                "bleed": effective_box(page, "/BleedBox"),
                "width": (media[2] - media[0]) if media else 0.0,
                "height": (media[3] - media[1]) if media else 0.0,
            })

            current = number

            def on_font(font, category, _n=current):
                # A Type 3 glyph inside an appearance stream is the
                # annotation's own drawing, not page content the press sets.
                name = _font_name(font)
                if (category != "annotation" and _font_subtype(font) == "Type3"
                        and name not in type3):
                    type3.append(name)
                note_embedding(font)

            def on_colorspace(cs, category, _n=current):
                try:
                    family = _family_of(cs)
                except Exception as exc:
                    note((COLORSPACE,), f"a colour space will not read: {exc}")
                    return
                if not family:
                    return
                key = (family, _n, category)
                if key in seen_colour:
                    return
                seen_colour.add(key)
                colour_uses.append(
                    {"family": family, "page": _n, "category": category}
                )

            def on_transparency(_n=current):
                transparent_pages.add(_n)

            walk_page_resources(
                page,
                on_font=on_font,
                on_colorspace=on_colorspace,
                on_transparency=on_transparency,
                on_unreadable=note,
            )

        # A per-page walk cannot reach a font named only by a Type 3 glyph
        # procedure or by `/AcroForm /DR`, and a font no walk sees cannot make
        # a check fail — so the embedding check reports a PASS over a face
        # that carries no program. The document walk answers the embedding
        # fact for every route; the category a font is reached BY stays the
        # page walk's, because only it knows which one that was.
        walk_document_fonts(
            pdf,
            lambda font, _page, _name: note_embedding(font),
            lambda _page, _name, detail: note((FONT,), detail),
        )

        reads["pages"] = pages
        reads["page_count"] = len(pages)
        # Read BEFORE anything opens the XMP packet: pikepdf CREATES one where
        # a document has none, so a metadata read performed first would report
        # the packet it had just invented.
        reads["has_xmp"] = "/Metadata" in pdf.Root
        reads["output_intents"] = _output_intents(pdf, note)
        reads["pdfx_claim"] = _pdfx_claim(pdf, reads["has_xmp"])
        reads["title"] = _document_title(pdf, reads["has_xmp"])
        reads["annotations"], annot_unreadable = _annotation_rows(pdf)
        for reason in annot_unreadable:
            note((), reason)
        reads["javascript"] = _javascript_sites(pdf)
        if {"min_type_size", "small_text_k_only"} & wanted:
            measurements, text_unreadable = document_contrast(pdf)
            reads["text_runs"] = measurements
            reads["text_error"] = ""
            for entry in text_unreadable:
                note((), f"page {entry.get('page')} will not parse")
        else:
            reads["text_runs"] = []
            reads["text_error"] = ""

    reads["non_embedded"] = non_embedded
    reads["type3_fonts"] = type3
    reads["colour_uses"] = colour_uses
    reads["transparent_pages"] = transparent_pages
    reads["font_count"] = len(font_names)

    advanced, _ = _safe(lambda: get_advanced_properties(file), None)
    reads["page_sizes"] = (advanced or {}).get("page_sizes", [])
    reads["trapped"] = (advanced or {}).get("trapped", "unknown")

    reads["structural"], reads["structural_error"] = _safe(
        lambda: structural_check(file), None
    )
    reads["attachments"], _ = _safe(lambda: list_attachments(file)["attachments"], None)
    reads["fonts"], reads["fonts_error"] = _safe(
        lambda: list_document_fonts(file, font_dir), None
    )
    reads["layers"], reads["layers_error"] = _safe(
        lambda: list_layers(file)["layers"], None
    )
    reads["fields"], reads["fields_error"] = _safe(
        lambda: read_form_fields(file)["fields"], None
    )

    if {"image_min_dpi_contone", "image_min_dpi_bitonal", "image_max_dpi",
            "image_compression"} & wanted:
        reads["images"], reads["images_error"] = _safe(
            lambda: summarize_image_resolution(file), None
        )
    else:
        reads["images"], reads["images_error"] = {"placements": [], "unmeasured": 0}, ""
    reads["placements"] = (reads["images"] or {}).get("placements", [])

    if {"spot_ink_count", "spot_ink_names"} & wanted:
        reads["inks"], reads["inks_error"] = _safe(lambda: list_inks(file), None)
    else:
        reads["inks"], reads["inks_error"] = {"inks": [], "unknown": []}, ""

    if "hairlines_absent" in wanted:
        params = resolved_params(profile, "hairlines_absent")
        reads["hairlines"], reads["hairlines_error"] = _safe(
            lambda: _hairlines(file, params), None
        )
        if reads["hairlines"] is not None:
            for reason in reads["hairlines"]["unreadable"]:
                note((), reason)
    else:
        reads["hairlines"], reads["hairlines_error"] = None, ""

    if "overprint" in wanted:
        reads["overprint"], reads["overprint_error"] = _safe(
            lambda: list_overprint(file), None
        )
        if reads["overprint"] is not None:
            for reason in reads["overprint"]["unreadable"]:
                note((), reason)
    else:
        reads["overprint"], reads["overprint_error"] = None, ""

    reads["unreadable"] = unreadable
    reads["hidden"] = hidden
    return reads


def _hairlines(file: str, params: dict) -> dict:
    from engine.hairlines import list_hairlines

    return list_hairlines(
        file,
        threshold_pt=float(params["threshold_pt"]),
        include_annotations=bool(params["include_annotations"]),
    )


def _output_intents(pdf, note) -> list | None:
    try:
        intents = pdf.Root.get("/OutputIntents")
    except Exception as exc:
        note((), f"the output intents will not read: {exc}")
        return None
    if intents is None:
        return []
    out: list = []
    try:
        for intent in intents:
            identifier = intent.get("/OutputConditionIdentifier")
            out.append({
                "subtype": str(intent.get("/S") or "").lstrip("/"),
                "identifier": str(identifier) if identifier is not None else "",
                "condition": str(intent.get("/OutputCondition") or ""),
                "embedded": intent.get("/DestOutputProfile") is not None,
            })
    except Exception as exc:
        note((), f"an output intent will not read: {exc}")
        return None
    return out


def _pdfx_claim(pdf, has_xmp: bool) -> str | None:
    """The PDF/X version the document CLAIMS, from docinfo or the XMP schema.

    Both are written by a conforming producer and either can be the one a
    consumer reads, so a claim in one and not the other is still a claim.
    """
    try:
        claim = pdf.docinfo.get("/GTS_PDFXVersion")
        if claim is not None:
            return str(claim)
    except Exception:
        return None
    if not has_xmp:
        return ""
    try:
        with pdf.open_metadata() as meta:
            for key in ("pdfxid:GTS_PDFXVersion", "pdfx:GTS_PDFXVersion"):
                value = meta.get(key)
                if value:
                    return str(value)
    except Exception:
        return ""
    return ""


def _document_title(pdf, has_xmp: bool) -> str:
    if has_xmp:
        try:
            with pdf.open_metadata() as meta:
                title = meta.get("dc:title")
                if title:
                    return str(title)
        except Exception:
            pass
    try:
        return str(pdf.docinfo.get("/Title") or "")
    except Exception:
        return ""


# ── the English the command line renders ──────────────────────────────────
#
# The flat `checks` array carries these because a reader with no catalog of
# its own still has to be able to print a report. Engine messages stay English
# at the engine; the panel renders the same rows from its own catalog.

_ENGLISH = {
    "pdf_version": ("PDF version is within range",
                    "A RIP that predates the file's version may not read it at all."),
    "print_permitted": ("Printing is permitted",
                        "Permission bits can forbid printing, or forbid it at full resolution."),
    "structurally_sound": ("Document is structurally sound",
                           "A damaged cross-reference table is a file a press may not open."),
    "output_intent": ("Output intent present",
                      "The output intent names the printing condition the colour was prepared for."),
    "pdfx_claim": ("PDF/X version claim matches",
                   "A document claiming a standard is judged against that standard."),
    "trapped_declared": ("Trapping state is declared",
                         "Whether the file is already trapped is a claim only a person may make."),
    "embedded_files": ("No embedded files",
                       "An attachment travels with the document and reaches the press with it."),
    "page_size_consistent": ("Page size is consistent",
                             "Pages of different sizes cannot be imposed as one signature."),
    "page_size_expected": ("Page size is the expected one",
                           "The job's own trim size is what the imposition was built around."),
    "trim_box": ("Trim box is defined",
                 "The trim box is where the page is cut; without it the cut is a guess."),
    "bleed_sufficient": ("Bleed is sufficient",
                         "Art must run past the trim, or a cutting tolerance shows white."),
    "page_count": ("Page count fits the job",
                   "A saddle-stitched job needs a page count its binding can fold."),
    "colour_family": ("No forbidden colour family",
                      "RGB on a press is converted by the RIP, to a colour nobody chose."),
    "grayscale_only": ("Grayscale only",
                       "A single-plate job must carry no colour a second plate would need."),
    "device_independent_colour": ("No device-independent colour",
                                  "Some standards require every colour to be device colour."),
    "spot_ink_count": ("Spot ink count is within the limit",
                       "Each spot ink is another plate, another wash-up and another cost."),
    "spot_ink_names": ("Spot inks are on the approved list",
                       "An ink named off the list is an ink the press has not mixed."),
    "ink_coverage_max": ("Total area coverage is within the limit",
                         "Too much ink on one spot does not dry; it sets off onto the next sheet."),
    "overprint": ("Overprint is deliberate",
                  "Ink set to overprint lays over what is under it instead of knocking it out."),
    "fonts_embedded": ("All fonts are embedded",
                       "A font the press does not have is a font the press substitutes."),
    "fonts_subset": ("Embedded fonts are subsets",
                     "A full face embeds every glyph, including the ones nothing sets."),
    "type3_fonts": ("No Type 3 fonts",
                    "A Type 3 glyph is a drawing, and it does not scale like an outline."),
    "min_type_size": ("Type is large enough to print",
                      "Below a certain size type fills in on press, and reversed type fills in sooner."),
    "small_text_k_only": ("Small black text is one ink",
                          "Black built from four inks needs registration small type will not hold."),
    "image_min_dpi_contone": ("Contone images are high enough resolution",
                              "A photograph below the screen's own resolution prints soft."),
    "image_min_dpi_bitonal": ("Bitonal images are high enough resolution",
                              "Line art carries its edges in its pixels and needs far more of them."),
    "image_max_dpi": ("Images are not over-resolution",
                      "Pixels beyond what the screen resolves cost time and buy nothing."),
    "image_compression": ("Image compression is permitted",
                          "Some standards forbid a codec a RIP of their era cannot decode."),
    "image_colour_space": ("Images are in a permitted colour space",
                           "An image in the wrong space is converted by the RIP, not by anyone."),
    "live_transparency": ("No live transparency",
                          "A RIP that cannot composite transparency flattens it, unpredictably."),
    "hairlines_absent": ("No hairline strokes",
                         "A hairline renders on screen and breaks up on an imagesetter."),
    "optional_content": ("No optional content",
                         "Which layers a RIP prints is a decision nobody made deliberately."),
    "printing_annotations": ("No printing annotations",
                             "An annotation flagged to print reaches the plate with the page."),
    "interactive_form": ("No interactive form",
                         "A form field prints its appearance, and its value may not be in it."),
    "title_present": ("Document has a title",
                      "The title is how a job is identified once the file name is gone."),
    "document_javascript": ("No document JavaScript",
                            "Scripting in a print file does nothing but travel with it."),
    "xmp_present": ("XMP metadata present",
                    "The standards read their own claims out of the XMP packet."),
}

_STATUS_ENGLISH = {
    PASS: "Passed",
    FAIL: "Failed",
    WARN: "Short of the recommendation",
    REVIEW: "Needs review",
    NA: "Not applicable",
}


def _with_english(row: dict) -> dict:
    label, explanation = _ENGLISH[row["id"]]
    detail = f"{_STATUS_ENGLISH[row['status']]}. {explanation}"
    findings = row["finding_count"]
    if findings:
        detail += f" {findings} of {row['counted']} checked."
    row["label"] = label
    row["detail"] = detail
    return row


# ── assembly ──────────────────────────────────────────────────────────────


def preflight(file: str, profile=None, profile_path: str = "", gs_path: str = "gs",
              font_dir: str | None = None) -> dict:
    """The print-readiness report, measured against one profile.

    Every check is one of `pass`, `fail`, `warn`, `needs_review` or
    `not_applicable`, and every row carries the parameters it was measured
    with. A CLEAN result is only a `pass` where the walk reached everything
    that check reads from; where it did not, the row is `needs_review` and
    names what it could not read.
    """
    resolved = resolve_profile(profile, profile_path)
    reads = _gather(file, resolved, gs_path, font_dir)

    checks: dict = {}
    for cid, category in CHECK_INVENTORY:
        checks[cid] = _Check(
            cid, category, check_severity(resolved, cid), resolved_params(resolved, cid)
        )

    for cid, category in CHECK_INVENTORY:
        check = checks[cid]
        if not check_enabled(resolved, cid):
            _disabled(check)
            continue
        _RUNNERS[cid](check, reads)

    # Fail-closed: a branch nobody could read cannot support a clean claim
    # from any check that reads it.
    for cid, fact in _READS_FACT.items():
        check = checks[cid]
        if fact not in reads["hidden"]:
            continue
        if check.status not in (PASS, NA) or check.data.get("na_reason") == "disabled":
            continue
        check.status = REVIEW
        check.findings = check.findings + [
            _finding(_page_address(), "unreadable_branch",
                     values={"reason": row["reason"]})
            for row in reads["unreadable"][:_REVIEW_DETAIL_CAP]
            if fact in row["affects"]
        ] or [_finding(_page_address(), "unreadable_branch", values={"reason": ""})]

    ordered = [checks[cid] for cid, _ in CHECK_INVENTORY]
    by_category = []
    for cat in CATEGORIES:
        rows = [c.to_json() for c in ordered if c.category == cat]
        by_category.append({
            "id": cat,
            "checks": rows,
            "passed": sum(1 for r in rows if r["status"] == PASS),
            "applicable": sum(1 for r in rows if r["status"] != NA),
        })
    summary = {
        "passed": sum(1 for c in ordered if c.status == PASS),
        "failed": sum(1 for c in ordered if c.status == FAIL),
        "warnings": sum(1 for c in ordered if c.status == WARN),
        "needs_review": sum(1 for c in ordered if c.status == REVIEW),
        "not_applicable": sum(1 for c in ordered if c.status == NA),
        "applicable": sum(1 for c in ordered if c.status != NA),
        "total": len(ordered),
    }
    return {
        "file": file,
        "profile": {
            "id": resolved["id"],
            "name": resolved.get("name", ""),
            "name_key": resolved.get("name_key", ""),
            "based_on": resolved.get("based_on", ""),
        },
        "categories": by_category,
        "summary": summary,
        "unreadable": reads["unreadable"],
        # The flat list, for a reader that has no notion of a category — the
        # same 37 rows in the same order, each carrying the English name and
        # sentence a caller with no catalog of its own renders.
        "checks": [_with_english(c.to_json()) for c in ordered],
        # The two bare numbers the shipped report put beside its checks. They
        # are context, not verdicts, and they stay context.
        "images": len(reads["placements"]),
        "color_families": sorted({u["family"] for u in reads["colour_uses"]}),
        **{k: summary[k] for k in
           ("passed", "failed", "warnings", "needs_review", "not_applicable", "total")},
    }


def list_preflight_profiles() -> dict:
    """The shipped profiles and the check inventory, for a surface that offers
    them without knowing how one is built."""
    from engine.preflight_profiles import list_preflight_profiles as _listed

    return _listed()


def validate_preflight_profile(profile: dict) -> dict:
    """Read one profile document, or refuse by name. The engine is the only
    validator: a second one on the other side of the bridge would be a second
    answer waiting to drift."""
    from engine.preflight_profiles import validate_profile

    return validate_profile(profile)
