"""Hidden-information audit — one categorized inventory of everything a
document carries that is not the page a reader sees.

The audit is a pure READ. It never writes, so it can run the moment a panel
opens and re-run after any edit; the removal half takes an explicit category
selection and is a separate call.

Three of the inventory's answers differ from what the shipped per-feature
readers report, and each difference is a correction:

  * embedded files are counted by REACHABILITY. A /Filespec reached through a
    /FileAttachment annotation is not in the catalog's /EmbeddedFiles name
    tree, so a name-tree walk under-reports a payload the file really carries.
  * metadata spans seven surfaces. Clearing the document information
    dictionary and the catalog XMP packet leaves page-level XMP, private
    application data on the catalog and on every page, page thumbnails and the
    document identifier in place.
  * prior REVISIONS hold content the newest revision removed. An
    incrementally-updated file truncated at its first end-of-file marker is a
    valid document that still extracts the deleted text, and a raw byte search
    for that text finds nothing because streams are compressed.

A category the audit could not read is reported in `unreadable` rather than
skipped: a sweep whose purpose is to say what is in a file may not pass
silently over a structure it failed to parse.
"""

from pathlib import Path

import pikepdf
from pikepdf import Name

from engine.docmdp import certification_of_pdf
from engine.inplace import finish_staged, is_same_file, staging_target
from engine.pdf_save import save_pdf
from engine.sanitize_content import analyze_page, off_ocg_set

# Every category, in report order. `signatures` is reported and never removed.
CATEGORY_IDS = (
    "metadata",
    "embedded_files",
    "bookmarks",
    "comments",
    "form_fields",
    "javascript",
    "hidden_layers",
    "hidden_text",
    "prior_revisions",
    "unreferenced_objects",
    "links_and_actions",
    "thumbnails",
    "attached_structure",
    "signatures",
)

# Categories a sanitize pass will not remove however they are selected.
UNREMOVABLE = frozenset({"signatures"})

# Categories a full save clears on its own: writing one revision is what drops
# the earlier ones, and a writer will not emit an object the trailer cannot
# reach. They are still selected explicitly and still counted, because a
# report that omits a class it silently fixed is a report nobody can check.
FREE_FROM_SAVE = frozenset({"prior_revisions", "unreferenced_objects"})

# Categories that cost the document something a reader may want, so no surface
# offers them pre-selected.
COSTLY = frozenset({"form_fields", "attached_structure"})

# The action types that are not navigation: each can reach outside the
# document or run something.
NON_LINK_ACTIONS = frozenset(
    {"/Launch", "/GoToR", "/SubmitForm", "/ImportData", "/URI", "/Movie", "/Sound", "/RichMedia"}
)

# Annotation subtypes that carry a comment rather than structure.
MARKUP_SUBTYPES = frozenset(
    {
        "/Text", "/FreeText", "/Line", "/Square", "/Circle", "/Polygon", "/PolyLine",
        "/Highlight", "/Underline", "/Squiggly", "/StrikeOut", "/Stamp", "/Caret",
        "/Ink", "/FileAttachment", "/Sound", "/Redact",
    }
)

# Per-category detail rows are capped so a document with tens of thousands of
# bookmarks or hidden runs still returns a payload a panel can render. The
# category's `count` is always the true total.
DETAIL_CAP = 200

# Hidden-text kinds the removal half will act on. Partial coverage is reported
# and never removed, because the uncovered half is content; the recognition
# sub-class is removable only when it is asked for by name.
REMOVABLE_TEXT_KINDS = frozenset({"invisible", "background_fill", "covered", "off_layer"})
OCR_TEXT_KIND = "ocr_layer"


def _text_of(obj) -> str:
    try:
        return str(obj) if obj is not None else ""
    except Exception:
        return ""


def _page_numbers(pdf, pages) -> list:
    total = len(pdf.pages)
    if pages is None or (isinstance(pages, str) and str(pages).lower() == "all"):
        return list(range(1, total + 1))
    if isinstance(pages, (int, float)):
        pages = [pages]
    out = []
    for value in pages:
        try:
            n = int(value)
        except (TypeError, ValueError):
            continue
        if 1 <= n <= total and n not in out:
            out.append(n)
    return sorted(out)


def _reachable(pdf) -> set:
    """Every object the trailer can reach. An object outside this set cannot
    be found by a conforming reader, but its bytes are still in the file."""
    seen: set = set()
    stack = [pdf.trailer]
    while stack:
        obj = stack.pop()
        try:
            og = obj.objgen
        except Exception:
            og = None
        if og is not None and og != (0, 0):
            if og in seen:
                continue
            seen.add(og)
        try:
            if isinstance(obj, (pikepdf.Dictionary, pikepdf.Stream)):
                for key in obj.keys():
                    try:
                        stack.append(obj[key])
                    except Exception:
                        continue
            elif isinstance(obj, pikepdf.Array):
                stack.extend(list(obj))
        except Exception:
            continue
    return seen


class _Report:
    """Collects category rows and the unreadable channel. Every detector runs
    inside `record`, so a detector that raises costs its own category and
    nothing else."""

    def __init__(self):
        self.rows: dict = {}
        self.unreadable: list = []

    def record(self, category: str, fn, removable: bool = True) -> None:
        try:
            count, detail, extra = fn()
        except Exception as exc:  # noqa: BLE001 — the failure IS the report
            self.unreadable.append({"category": category, "page": None, "reason": str(exc)})
            self.rows[category] = {
                "id": category,
                "count": 0,
                "removable": removable,
                "detail": [],
                "unreadable": True,
            }
            return
        row = {
            "id": category,
            "count": int(count),
            "removable": bool(removable),
            "detail": list(detail)[:DETAIL_CAP],
        }
        if len(detail) > DETAIL_CAP:
            row["detail_truncated"] = True
        row.update(extra or {})
        self.rows[category] = row

    def result(self) -> list:
        return [self.rows[cid] for cid in CATEGORY_IDS if cid in self.rows]


# ── detectors ─────────────────────────────────────────────────────────────


def _detect_metadata(pdf, page_numbers):
    detail = []
    count = 0
    info = pdf.trailer.get("/Info")
    if isinstance(info, pikepdf.Dictionary):
        keys = [str(k).lstrip("/") for k in info.keys()]
        if keys:
            detail.append({"where": "document info", "keys": sorted(keys)})
            count += 1
    if "/Metadata" in pdf.Root:
        detail.append({"where": "document", "keys": ["XMP packet"]})
        count += 1
    if "/PieceInfo" in pdf.Root:
        detail.append({"where": "document", "keys": ["private application data"]})
        count += 1
    for n in page_numbers:
        page = pdf.pages[n - 1].obj
        if "/Metadata" in page:
            detail.append({"where": f"page {n}", "keys": ["XMP packet"]})
            count += 1
        if "/PieceInfo" in page:
            detail.append({"where": f"page {n}", "keys": ["private application data"]})
            count += 1
    if "/ID" in pdf.trailer:
        # A writer always emits a document identifier, so this surface cannot
        # go away; a full save mints a fresh pair and the identifier the file
        # arrived with stops being in it. Reported, never counted — a count
        # that can never reach zero would make the after-report unreadable.
        detail.append({"where": "document identifier", "keys": ["ID"], "replaced": True})
    return count, detail, {}


def _filespec_routes(pdf, page_numbers) -> list:
    """Every /Filespec that carries an embedded file, with how it is reached.
    The route decides which remover takes it."""
    found: dict = {}

    def note(spec, via, page=None):
        try:
            og = spec.objgen
        except Exception:
            og = None
        key = og if og and og != (0, 0) else id(spec)
        if key in found:
            return
        ef = spec.get("/EF") if isinstance(spec, pikepdf.Dictionary) else None
        if not isinstance(ef, pikepdf.Dictionary):
            return
        size = 0
        for k in ef.keys():
            stream = ef[k]
            if isinstance(stream, pikepdf.Stream):
                try:
                    size = max(size, len(stream.read_bytes()))
                except Exception:
                    params = stream.get("/Params")
                    if isinstance(params, pikepdf.Dictionary) and "/Size" in params:
                        try:
                            size = max(size, int(params["/Size"]))
                        except (TypeError, ValueError):
                            pass
        name = _text_of(spec.get("/UF") or spec.get("/F")) or "(unnamed)"
        row = {"name": name, "bytes": size, "via": via}
        if page is not None:
            row["page"] = page
        found[key] = row

    names = pdf.Root.get("/Names")
    if isinstance(names, pikepdf.Dictionary) and isinstance(
        names.get("/EmbeddedFiles"), pikepdf.Dictionary
    ):
        for _name, spec in pikepdf.NameTree(names["/EmbeddedFiles"]).items():
            if isinstance(spec, pikepdf.Dictionary):
                note(spec, "name tree")

    for n in page_numbers:
        annots = pdf.pages[n - 1].obj.get("/Annots")
        if not isinstance(annots, pikepdf.Array):
            continue
        for annot in annots:
            if not isinstance(annot, pikepdf.Dictionary):
                continue
            spec = annot.get("/FS")
            if isinstance(spec, pikepdf.Dictionary):
                note(spec, "annotation", page=n)
            rich = annot.get("/RichMediaContent")
            if isinstance(rich, pikepdf.Dictionary) and isinstance(
                rich.get("/Assets"), pikepdf.Dictionary
            ):
                for _name, asset in pikepdf.NameTree(rich["/Assets"]).items():
                    if isinstance(asset, pikepdf.Dictionary):
                        note(asset, "rich media", page=n)

    # Anything left is reachable from somewhere this walk does not name; it is
    # still in the file, so it is still reported.
    for obj in pdf.objects:
        try:
            if isinstance(obj, pikepdf.Dictionary) and str(obj.get("/Type", "")) == "/Filespec":
                note(obj, "elsewhere")
        except Exception:
            continue
    return list(found.values())


def _detect_embedded_files(pdf, page_numbers):
    rows = _filespec_routes(pdf, page_numbers)
    return len(rows), rows, {}


def _outline_rows(pdf) -> list:
    rows: list = []

    def walk(items, depth):
        for item in items:
            title = _text_of(getattr(item, "title", ""))
            rows.append({"title": title, "depth": depth})
            walk(getattr(item, "children", []) or [], depth + 1)

    with pdf.open_outline() as ol:
        walk(ol.root, 0)
    return rows


def _detect_bookmarks(pdf, page_numbers):
    rows = _outline_rows(pdf)
    return len(rows), rows, {}


def _detect_comments(pdf, page_numbers):
    rows = []
    for n in page_numbers:
        annots = pdf.pages[n - 1].obj.get("/Annots")
        if not isinstance(annots, pikepdf.Array):
            continue
        for annot in annots:
            if not isinstance(annot, pikepdf.Dictionary):
                continue
            subtype = str(annot.get("/Subtype", ""))
            if subtype not in MARKUP_SUBTYPES:
                continue
            rows.append(
                {
                    "page": n,
                    "subtype": subtype.lstrip("/"),
                    "author": _text_of(annot.get("/T")),
                    "contents": _text_of(annot.get("/Contents")),
                }
            )
    return len(rows), rows, {}


def _acroform(pdf):
    acro = pdf.Root.get("/AcroForm")
    return acro if isinstance(acro, pikepdf.Dictionary) else None


def _field_rows(acro) -> list:
    rows: list = []
    if acro is None:
        return rows
    fields = acro.get("/Fields")
    if not isinstance(fields, pikepdf.Array):
        return rows

    def walk(nodes, prefix, depth):
        if depth > 32:
            return
        for node in nodes:
            if not isinstance(node, pikepdf.Dictionary):
                continue
            partial = _text_of(node.get("/T"))
            name = f"{prefix}.{partial}" if prefix and partial else (partial or prefix)
            kids = node.get("/Kids")
            child_fields = []
            if isinstance(kids, pikepdf.Array):
                child_fields = [
                    k for k in kids
                    if isinstance(k, pikepdf.Dictionary) and str(k.get("/Subtype", "")) != "/Widget"
                ]
            if child_fields:
                walk(child_fields, name, depth + 1)
                continue
            if "/FT" in node or partial:
                rows.append(
                    {
                        "name": name or "(unnamed)",
                        "type": str(node.get("/FT", "")).lstrip("/"),
                        "value": _text_of(node.get("/V")),
                    }
                )

    walk(list(fields), "", 0)
    return rows


def _detect_form_fields(pdf, page_numbers):
    acro = _acroform(pdf)
    rows = _field_rows(acro)
    has_xfa = acro is not None and "/XFA" in acro
    return len(rows), rows, {"xfa": bool(has_xfa)}


def _is_js_action(action) -> bool:
    return isinstance(action, pikepdf.Dictionary) and str(action.get("/S", "")) == "/JavaScript"


def _action_chain(action, depth: int = 0):
    """An action and everything its /Next chains to."""
    if not isinstance(action, pikepdf.Dictionary) or depth > 16:
        return
    yield action
    nxt = action.get("/Next")
    if isinstance(nxt, pikepdf.Dictionary):
        yield from _action_chain(nxt, depth + 1)
    elif isinstance(nxt, pikepdf.Array):
        for entry in nxt:
            yield from _action_chain(entry, depth + 1)


def _detect_javascript(pdf, page_numbers):
    rows: list = []
    names = pdf.Root.get("/Names")
    if isinstance(names, pikepdf.Dictionary) and isinstance(
        names.get("/JavaScript"), pikepdf.Dictionary
    ):
        for name, action in pikepdf.NameTree(names["/JavaScript"]).items():
            if _is_js_action(action):
                rows.append({"site": "name_tree", "where": f"document script: {name}"})
    for action in _action_chain(pdf.Root.get("/OpenAction")):
        if _is_js_action(action):
            rows.append({"site": "open_action", "where": "open action"})
    catalog_aa = pdf.Root.get("/AA")
    if isinstance(catalog_aa, pikepdf.Dictionary):
        for key in catalog_aa.keys():
            for action in _action_chain(catalog_aa[key]):
                if _is_js_action(action):
                    rows.append(
                        {"site": "catalog_aa", "where": f"document action: {str(key).lstrip('/')}"}
                    )
    for n in page_numbers:
        page = pdf.pages[n - 1].obj
        page_aa = page.get("/AA")
        if isinstance(page_aa, pikepdf.Dictionary):
            for key in page_aa.keys():
                for action in _action_chain(page_aa[key]):
                    if _is_js_action(action):
                        rows.append(
                            {
                                "site": "page_aa",
                                "page": n,
                                "where": f"page {n} action: {str(key).lstrip('/')}",
                            }
                        )
        annots = page.get("/Annots")
        if not isinstance(annots, pikepdf.Array):
            continue
        for annot in annots:
            if not isinstance(annot, pikepdf.Dictionary):
                continue
            label = _text_of(annot.get("/T")) or str(annot.get("/Subtype", "")).lstrip("/")
            annot_aa = annot.get("/AA")
            if isinstance(annot_aa, pikepdf.Dictionary):
                for key in annot_aa.keys():
                    for action in _action_chain(annot_aa[key]):
                        if _is_js_action(action):
                            rows.append(
                                {
                                    "site": "annotation_aa",
                                    "page": n,
                                    "where": f"{label} action: {str(key).lstrip('/')}",
                                }
                            )
            for action in _action_chain(annot.get("/A")):
                if _is_js_action(action):
                    rows.append(
                        {"site": "annotation_action", "page": n, "where": f"{label} action"}
                    )
    return len(rows), rows, {}


def _detect_hidden_layers(pdf, page_numbers, blocks_by_layer_total: int):
    off_set = off_ocg_set(pdf)
    ocp = pdf.Root.get("/OCProperties")
    rows = []
    if isinstance(ocp, pikepdf.Dictionary) and isinstance(ocp.get("/OCGs"), pikepdf.Array):
        for i, ocg in enumerate(ocp["/OCGs"]):
            try:
                og = ocg.objgen
            except Exception:
                og = None
            if og is None or og not in off_set:
                continue
            rows.append({"index": i, "name": _text_of(ocg.get("/Name")) or f"Layer {i + 1}"})
    return len(rows), rows, {"content_blocks": blocks_by_layer_total}


def _detect_prior_revisions(raw: bytes, signature_count: int):
    markers = raw.count(b"%%EOF")
    revisions = max(1, markers)
    prior = max(0, revisions - 1)
    first = raw.find(b"%%EOF")
    detail = [
        {
            "revisions": revisions,
            "recoverable_bytes": (first + 5) if (prior and first >= 0) else 0,
            "destroys_signatures": signature_count if prior else 0,
        }
    ]
    return prior, detail, {}


def _detect_unreferenced(pdf):
    reachable = _reachable(pdf)
    stray = 0
    for obj in pdf.objects:
        try:
            og = obj.objgen
        except Exception:
            continue
        if og and og != (0, 0) and og not in reachable:
            stray += 1
    return stray, ([{"objects": stray}] if stray else []), {}


def _link_target(pdf, annot) -> tuple:
    action = annot.get("/A")
    if isinstance(action, pikepdf.Dictionary):
        kind = str(action.get("/S", ""))
        if kind == "/URI":
            return "uri", _text_of(action.get("/URI"))
        if kind == "/GoTo":
            return "internal", "internal destination"
        return kind.lstrip("/").lower() or "action", _text_of(action.get("/F")) or kind.lstrip("/")
    if annot.get("/Dest") is not None:
        return "internal", "internal destination"
    return "none", ""


def _detect_links_and_actions(pdf, page_numbers):
    rows: list = []
    for n in page_numbers:
        page = pdf.pages[n - 1].obj
        annots = page.get("/Annots")
        if isinstance(annots, pikepdf.Array):
            for annot in annots:
                if not isinstance(annot, pikepdf.Dictionary):
                    continue
                subtype = str(annot.get("/Subtype", ""))
                if subtype == "/Link":
                    kind, target = _link_target(pdf, annot)
                    rows.append({"page": n, "site": "link", "kind": kind, "target": target})
                    continue
                for action in _action_chain(annot.get("/A")):
                    kind = str(action.get("/S", ""))
                    if kind in NON_LINK_ACTIONS:
                        rows.append(
                            {
                                "page": n,
                                "site": "annotation_action",
                                "kind": kind.lstrip("/"),
                                "target": _text_of(action.get("/URI") or action.get("/F")),
                            }
                        )
        page_aa = page.get("/AA")
        if isinstance(page_aa, pikepdf.Dictionary):
            for key in page_aa.keys():
                for action in _action_chain(page_aa[key]):
                    kind = str(action.get("/S", ""))
                    if kind in NON_LINK_ACTIONS:
                        rows.append(
                            {
                                "page": n,
                                "site": "page_aa",
                                "kind": kind.lstrip("/"),
                                "target": _text_of(action.get("/URI") or action.get("/F")),
                            }
                        )
    for action in _action_chain(pdf.Root.get("/OpenAction")):
        kind = str(action.get("/S", ""))
        if kind in NON_LINK_ACTIONS:
            rows.append(
                {
                    "site": "open_action",
                    "kind": kind.lstrip("/"),
                    "target": _text_of(action.get("/URI") or action.get("/F")),
                }
            )
    catalog_aa = pdf.Root.get("/AA")
    if isinstance(catalog_aa, pikepdf.Dictionary):
        for key in catalog_aa.keys():
            for action in _action_chain(catalog_aa[key]):
                kind = str(action.get("/S", ""))
                if kind in NON_LINK_ACTIONS:
                    rows.append(
                        {"site": "catalog_aa", "kind": kind.lstrip("/"), "target": ""}
                    )
    return len(rows), rows, {}


def _detect_thumbnails(pdf, page_numbers):
    rows = [{"page": n} for n in page_numbers if "/Thumb" in pdf.pages[n - 1].obj]
    return len(rows), rows, {}


def _detect_attached_structure(pdf, page_numbers):
    rows: list = []
    if "/StructTreeRoot" in pdf.Root:
        rows.append({"where": "structure tree"})
    if "/Lang" in pdf.Root:
        rows.append({"where": "language", "value": _text_of(pdf.Root.get("/Lang"))})
    threads = pdf.Root.get("/Threads")
    if isinstance(threads, pikepdf.Array):
        for thread in threads:
            title = ""
            if isinstance(thread, pikepdf.Dictionary) and isinstance(
                thread.get("/I"), pikepdf.Dictionary
            ):
                title = _text_of(thread["/I"].get("/Title"))
            rows.append({"where": "article thread", "value": title})
    return len(rows), rows, {}


def certification_level(pdf) -> str | None:
    """The DocMDP permission a certification signature asserts, as the wire
    level name, or None when the document is not certified. A certified
    document states what may change after signing, and a sanitize pass changes
    more than any level permits.

    A certification whose level cannot be read still reports as certified: the
    warning that matters is the certification's existence, not its degree."""
    state = certification_of_pdf(pdf)
    if not state["certified"]:
        return None
    return state["level"] or "unknown"


def _signature_summary(file: str, pdf) -> dict:
    from engine.signatures import verify_signatures

    try:
        verdict = verify_signatures(file)
        count = int(verdict.get("signature_count", 0))
        timestamps = int(verdict.get("document_timestamps", 0))
        fields = [
            {"field": s.get("field"), "signer": s.get("signer")}
            for s in verdict.get("signatures", [])
        ]
    except Exception:
        # A signature we cannot verify is still a signature: fall back to the
        # structural count so the warning is never silently dropped.
        count = 0
        timestamps = 0
        fields = []
        acro = _acroform(pdf)
        if acro is not None:
            for row in _field_rows(acro):
                if row["type"] == "Sig" and row["value"]:
                    count += 1
                    fields.append({"field": row["name"], "signer": None})
    return {
        "count": count,
        "document_timestamps": timestamps,
        "certification": certification_level(pdf),
        "fields": fields,
    }


# ── the audit door ────────────────────────────────────────────────────────


def audit_hidden_information(file: str, pages="all", deep_text: bool = True) -> dict:
    """Inventory everything in `file` that is not the visible page.

    Args:
        file: PDF path.
        pages: Pages the per-page detectors report on ("all", or a list of
            1-based numbers). Removal is always document-wide; this scopes the
            REPORT.
        deep_text: Walk the content streams for text a reader cannot see.
            Turning it off leaves `hidden_text` at zero and says so in
            `unreadable`.
    """
    raw = b""
    try:
        with open(file, "rb") as handle:
            raw = handle.read()
    except OSError:
        raw = b""

    report = _Report()
    with pikepdf.open(file) as pdf:
        page_numbers = _page_numbers(pdf, pages)
        signatures = _signature_summary(file, pdf)

        hidden_runs: list = []
        layer_blocks = 0
        text_failed: list = []
        if deep_text:
            off_set = off_ocg_set(pdf)
            for n in page_numbers:
                try:
                    found = analyze_page(pdf, pdf.pages[n - 1], off_set)
                except Exception as exc:  # noqa: BLE001 — the page names itself
                    text_failed.append({"category": "hidden_text", "page": n, "reason": str(exc)})
                    continue
                layer_blocks += found["layer_blocks"]
                for run in found["runs"]:
                    hidden_runs.append(
                        {
                            "page": n,
                            "index": run.index,
                            "kind": run.kind,
                            "text": run.text[:120],
                        }
                    )

        report.record("metadata", lambda: _detect_metadata(pdf, page_numbers))
        report.record("embedded_files", lambda: _detect_embedded_files(pdf, page_numbers))
        report.record("bookmarks", lambda: _detect_bookmarks(pdf, page_numbers))
        report.record("comments", lambda: _detect_comments(pdf, page_numbers))
        report.record("form_fields", lambda: _detect_form_fields(pdf, page_numbers))
        report.record("javascript", lambda: _detect_javascript(pdf, page_numbers))
        report.record(
            "hidden_layers", lambda: _detect_hidden_layers(pdf, page_numbers, layer_blocks)
        )
        if deep_text:
            by_kind: dict = {}
            for run in hidden_runs:
                by_kind[run["kind"]] = by_kind.get(run["kind"], 0) + 1
            report.record(
                "hidden_text",
                lambda: (len(hidden_runs), hidden_runs, {"by_kind": by_kind}),
            )
        else:
            report.rows["hidden_text"] = {
                "id": "hidden_text",
                "count": 0,
                "removable": True,
                "detail": [],
                "unreadable": True,
            }
            report.unreadable.append(
                {
                    "category": "hidden_text",
                    "page": None,
                    "reason": "the content streams were not analyzed",
                }
            )
        report.unreadable.extend(text_failed)
        report.record(
            "prior_revisions", lambda: _detect_prior_revisions(raw, signatures["count"])
        )
        report.record("unreferenced_objects", lambda: _detect_unreferenced(pdf))
        report.record("links_and_actions", lambda: _detect_links_and_actions(pdf, page_numbers))
        report.record("thumbnails", lambda: _detect_thumbnails(pdf, page_numbers))
        report.record("attached_structure", lambda: _detect_attached_structure(pdf, page_numbers))
        report.record(
            "signatures",
            lambda: (
                signatures["count"] + signatures["document_timestamps"],
                signatures["fields"],
                {"certification": signatures["certification"]},
            ),
            removable=False,
        )

        return {
            "file": file,
            "categories": report.result(),
            "signatures": {
                "count": signatures["count"],
                "document_timestamps": signatures["document_timestamps"],
                "certification": signatures["certification"],
            },
            "pages_analyzed": len(page_numbers),
            "pages": len(pdf.pages),
            "unreadable": report.unreadable,
        }


# ── removers ──────────────────────────────────────────────────────────────


def _remove_metadata(pdf) -> int:
    """Every metadata surface, not only the two a docinfo sweep reaches.

    The document identifier is deliberately DELETED rather than cleared: a
    writer mints a fresh pair when the trailer carries none, so the identifier
    the file arrived with stops being in it. Clearing the XMP packet instead of
    deleting it leaves a packet behind, which is what makes a second audit
    still report the surface.
    """
    removed = 0
    info = pdf.trailer.get("/Info")
    if isinstance(info, pikepdf.Dictionary) and len(info.keys()):
        removed += 1
    if "/Info" in pdf.trailer:
        del pdf.trailer["/Info"]
    for key in ("/Metadata", "/PieceInfo"):
        if key in pdf.Root:
            del pdf.Root[key]
            removed += 1
    for page in pdf.pages:
        for key in ("/Metadata", "/PieceInfo"):
            if key in page.obj:
                del page.obj[key]
                removed += 1
    if "/ID" in pdf.trailer:
        del pdf.trailer["/ID"]
    return removed


def _remove_embedded_files(pdf) -> int:
    """Both reachability routes in one pass. An embedded file reached through
    an annotation is not in the name tree, so dropping the tree alone leaves
    the payload in the file."""
    specs = _filespec_routes(pdf, list(range(1, len(pdf.pages) + 1)))
    names = pdf.Root.get("/Names")
    if isinstance(names, pikepdf.Dictionary) and "/EmbeddedFiles" in names:
        del names["/EmbeddedFiles"]
        if not len(names.keys()):
            del pdf.Root["/Names"]
    if "/Collection" in pdf.Root:
        del pdf.Root["/Collection"]
    for page in pdf.pages:
        annots = page.obj.get("/Annots")
        if not isinstance(annots, pikepdf.Array):
            continue
        kept = [
            a
            for a in annots
            if not (
                isinstance(a, pikepdf.Dictionary)
                and (a.get("/FS") is not None or a.get("/RichMediaContent") is not None)
            )
        ]
        _write_annots(page, kept)
    return len(specs)


def _write_annots(page, kept: list) -> None:
    if kept:
        page.obj["/Annots"] = pikepdf.Array(kept)
    elif "/Annots" in page.obj:
        del page.obj["/Annots"]


def _remove_bookmarks(pdf) -> int:
    removed = len(_outline_rows(pdf))
    if "/Outlines" in pdf.Root:
        del pdf.Root["/Outlines"]
    return removed


def _remove_comments(pdf) -> int:
    sweep = MARKUP_SUBTYPES | {"/Popup"}
    removed = 0
    for page in pdf.pages:
        annots = page.obj.get("/Annots")
        if not isinstance(annots, pikepdf.Array):
            continue
        kept = []
        for annot in annots:
            subtype = (
                str(annot.get("/Subtype", "")) if isinstance(annot, pikepdf.Dictionary) else ""
            )
            if subtype in sweep:
                removed += 1
                continue
            kept.append(annot)
        _write_annots(page, kept)
    return removed


def _remove_form_fields(pdf, mode: str) -> int:
    from engine.forms import _flatten_fields

    removed = len(_field_rows(_acroform(pdf)))
    if mode == "flatten":
        _flatten_fields(pdf)
        return removed
    for page in pdf.pages:
        annots = page.obj.get("/Annots")
        if not isinstance(annots, pikepdf.Array):
            continue
        kept = [
            a
            for a in annots
            if not (
                isinstance(a, pikepdf.Dictionary) and str(a.get("/Subtype", "")) == "/Widget"
            )
        ]
        _write_annots(page, kept)
    if "/AcroForm" in pdf.Root:
        del pdf.Root["/AcroForm"]
    return removed


def _remove_document_scripts(pdf) -> int:
    """The catalog's named script tree."""
    names = pdf.Root.get("/Names")
    if not isinstance(names, pikepdf.Dictionary):
        return 0
    tree = names.get("/JavaScript")
    if not isinstance(tree, pikepdf.Dictionary):
        return 0
    removed = sum(1 for _n, action in pikepdf.NameTree(tree).items() if _is_js_action(action))
    del names["/JavaScript"]
    if not len(names.keys()):
        del pdf.Root["/Names"]
    return removed


def _strip_actions(action, matches, depth: int = 0):
    """Rebuild an action chain without the actions `matches` selects.

    An action's `/Next` is a chain, so removing one link must splice rather
    than truncate: everything the removed action would have run afterwards
    still runs. Returns (replacement or None, removed count)."""
    if not isinstance(action, pikepdf.Dictionary) or depth > 16:
        return action, 0
    removed = 0
    following = action.get("/Next")
    if isinstance(following, pikepdf.Array):
        kept_next = []
        for entry in following:
            replacement, sub = _strip_actions(entry, matches, depth + 1)
            removed += sub
            if replacement is not None:
                kept_next.append(replacement)
        following = pikepdf.Array(kept_next) if kept_next else None
    elif isinstance(following, pikepdf.Dictionary):
        following, sub = _strip_actions(following, matches, depth + 1)
        removed += sub
    else:
        following = None
    if matches(action):
        return following, removed + 1
    if following is None:
        if "/Next" in action:
            del action["/Next"]
    else:
        action["/Next"] = following
    return action, removed


def _strip_action_slot(container, key, matches) -> int:
    """Prune one `/A` or one `/AA` entry in place."""
    if not isinstance(container, pikepdf.Dictionary):
        return 0
    slot = container.get(Name(key)) if isinstance(key, str) else container.get(key)
    if not isinstance(slot, pikepdf.Dictionary):
        return 0
    replacement, removed = _strip_actions(slot, matches)
    if replacement is None:
        del container[key]
    else:
        container[key] = replacement
    return removed


def _action_sites(pdf):
    """Every dictionary that owns an action slot, with the slot's key. The
    additional-action dictionaries are enumerated by their own keys, so a
    document, page, field or annotation trigger is reached the same way."""
    def emit(owner):
        if not isinstance(owner, pikepdf.Dictionary):
            return
        if isinstance(owner.get("/A"), pikepdf.Dictionary):
            yield owner, "/A"
        extra = owner.get("/AA")
        if isinstance(extra, pikepdf.Dictionary):
            for key in [str(k) for k in extra.keys()]:
                yield extra, key

    if isinstance(pdf.Root.get("/OpenAction"), pikepdf.Dictionary):
        yield pdf.Root, "/OpenAction"
    catalog_aa = pdf.Root.get("/AA")
    if isinstance(catalog_aa, pikepdf.Dictionary):
        for key in [str(k) for k in catalog_aa.keys()]:
            yield catalog_aa, key
    for page in pdf.pages:
        yield from emit(page.obj)
        annots = page.obj.get("/Annots")
        if not isinstance(annots, pikepdf.Array):
            continue
        for annot in annots:
            yield from emit(annot)


def _prune_empty_action_dicts(pdf) -> None:
    for owner in [pdf.Root] + [p.obj for p in pdf.pages]:
        extra = owner.get("/AA")
        if isinstance(extra, pikepdf.Dictionary) and not len(extra.keys()):
            del owner["/AA"]
    for page in pdf.pages:
        annots = page.obj.get("/Annots")
        if not isinstance(annots, pikepdf.Array):
            continue
        for annot in annots:
            if not isinstance(annot, pikepdf.Dictionary):
                continue
            extra = annot.get("/AA")
            if isinstance(extra, pikepdf.Dictionary) and not len(extra.keys()):
                del annot["/AA"]


def _remove_javascript(pdf) -> int:
    """All five script sites. The named tree is one of them; the other four are
    action dictionaries — the open action, and the additional actions on the
    catalog, the pages and their annotations and fields."""
    removed = _remove_document_scripts(pdf)
    for container, key in list(_action_sites(pdf)):
        removed += _strip_action_slot(container, key, _is_js_action)
    _prune_empty_action_dicts(pdf)
    return removed


def _is_non_link_action(action) -> bool:
    return isinstance(action, pikepdf.Dictionary) and str(action.get("/S", "")) in NON_LINK_ACTIONS


def _remove_links_and_actions(pdf) -> int:
    """Link annotations, and every action that reaches outside the document or
    runs something. A link's own action goes with the annotation, so the two
    halves cannot double-count."""
    removed = 0
    for page in pdf.pages:
        annots = page.obj.get("/Annots")
        if not isinstance(annots, pikepdf.Array):
            continue
        kept = []
        for annot in annots:
            if isinstance(annot, pikepdf.Dictionary) and str(annot.get("/Subtype", "")) == "/Link":
                removed += 1
                continue
            kept.append(annot)
        _write_annots(page, kept)
    for container, key in list(_action_sites(pdf)):
        removed += _strip_action_slot(container, key, _is_non_link_action)
    _prune_empty_action_dicts(pdf)
    return removed


def _remove_hidden_text(pdf, hidden_text_ocr: bool) -> int:
    """Text a reader cannot see, removed run by run.

    The pages are re-analyzed against the LIVE document rather than against the
    audit taken before it: an earlier category in the same pass can rewrite a
    content stream, and a run id names a position in the stream it was read
    from.

    Partially covered runs are never removed — the uncovered half is content —
    and a recognition layer goes only when it is asked for by name, because
    removing it makes a scan unsearchable.
    """
    from engine.sanitize_content import analyze_page, remove_runs

    kinds = set(REMOVABLE_TEXT_KINDS)
    if hidden_text_ocr:
        kinds.add(OCR_TEXT_KIND)
    off_set = off_ocg_set(pdf)
    removed = 0
    for page in pdf.pages:
        found = analyze_page(pdf, page, off_set)
        targets = {run.index for run in found["runs"] if run.kind in kinds}
        if targets:
            removed += remove_runs(pdf, page, targets)
    return removed


def _remove_hidden_layers(pdf) -> int:
    from engine.sanitize_content import drop_optional_content_groups, remove_hidden_layer_content

    off_set = off_ocg_set(pdf)
    if not off_set:
        return 0
    remove_hidden_layer_content(pdf, off_set)
    return drop_optional_content_groups(pdf, off_set)


def _remove_thumbnails(pdf) -> int:
    removed = 0
    for page in pdf.pages:
        if "/Thumb" in page.obj:
            del page.obj["/Thumb"]
            removed += 1
    return removed


def _remove_attached_structure(pdf) -> int:
    removed = 0
    for key in ("/StructTreeRoot", "/Lang"):
        if key in pdf.Root:
            del pdf.Root[key]
            removed += 1
    threads = pdf.Root.get("/Threads")
    if isinstance(threads, pikepdf.Array):
        removed += len(threads)
        del pdf.Root["/Threads"]
    if "/MarkInfo" in pdf.Root:
        del pdf.Root["/MarkInfo"]
    for page in pdf.pages:
        if "/StructParents" in page.obj:
            del page.obj["/StructParents"]
        annots = page.obj.get("/Annots")
        if not isinstance(annots, pikepdf.Array):
            continue
        for annot in annots:
            if isinstance(annot, pikepdf.Dictionary) and "/StructParent" in annot:
                del annot["/StructParent"]
    return removed


# One remover per category, keyed by the id the audit reports. A category with
# no entry here is one whose removal does not exist, and looking it up fails
# rather than reporting a removal that never happened.
REMOVERS = {
    "metadata": lambda pdf, audit, options: _remove_metadata(pdf),
    "embedded_files": lambda pdf, audit, options: _remove_embedded_files(pdf),
    "bookmarks": lambda pdf, audit, options: _remove_bookmarks(pdf),
    "comments": lambda pdf, audit, options: _remove_comments(pdf),
    "form_fields": lambda pdf, audit, options: _remove_form_fields(
        pdf, options["form_fields_mode"]
    ),
    "javascript": lambda pdf, audit, options: _remove_javascript(pdf),
    "hidden_layers": lambda pdf, audit, options: _remove_hidden_layers(pdf),
    "hidden_text": lambda pdf, audit, options: _remove_hidden_text(
        pdf, options["hidden_text_ocr"]
    ),
    "links_and_actions": lambda pdf, audit, options: _remove_links_and_actions(pdf),
    "thumbnails": lambda pdf, audit, options: _remove_thumbnails(pdf),
    "attached_structure": lambda pdf, audit, options: _remove_attached_structure(pdf),
}

# Every category a selection may name: those with a remover, plus the two the
# full save clears on its own.
REMOVERS_OR_FREE = frozenset(REMOVERS) | FREE_FROM_SAVE


# ── the sanitize door ─────────────────────────────────────────────────────


def _selection(categories, all_removable: bool = False) -> list:
    if all_removable and not categories:
        # Everything except the categories that cost the document something.
        # A convenience that silently destroyed an accessibility tree would be
        # the same defect as a surface that pre-checked it.
        return [
            cid
            for cid in CATEGORY_IDS
            if cid not in UNREMOVABLE and cid not in COSTLY and cid in REMOVERS_OR_FREE
        ]
    if not categories:
        raise ValueError(
            "Choose at least one category to remove — sanitize never removes "
            "everything by default."
        )
    chosen = []
    for entry in categories:
        name = str(entry)
        if name not in CATEGORY_IDS:
            raise ValueError(
                f"Unknown category {name!r}. The categories are: {', '.join(CATEGORY_IDS)}."
            )
        if name in UNREMOVABLE:
            raise ValueError(
                f"{name} is reported and never removed — take it out of the selection."
            )
        if name not in chosen:
            chosen.append(name)
    return chosen


def _refuse_unreadable(audit: dict) -> None:
    """A sweep whose purpose is to say what is in a file may not pass silently
    over a structure it failed to parse. The two messages are separate rather
    than one message with an optional fragment: adjacent placeholders cannot be
    told apart when the refusal is matched back to its catalog entry."""
    for entry in audit["unreadable"]:
        if entry.get("page"):
            raise ValueError(
                f"The audit could not read {entry['category']} on page {entry['page']}, "
                f"so this document cannot be sanitized: {entry['reason']}"
            )
        raise ValueError(
            f"The audit could not read {entry['category']}, so this document cannot "
            f"be sanitized: {entry['reason']}"
        )


def sanitize_pdf(
    file: str,
    output: str,
    categories: list | None = None,
    form_fields_mode: str = "remove",
    hidden_text_ocr: bool = False,
    all_removable: bool = False,
) -> dict:
    """Remove exactly the selected categories and write the result.

    Scope is the whole document. Sanitize is a document-level guarantee, and a
    per-page sweep would produce a file the user believes is clean and is not.

    The save is an ordinary FULL save, never an incremental append: collapsing
    prior revisions is what removes content the newest revision deleted, and an
    append would add a revision instead of dropping one. On a signed document
    that invalidates the signatures, which is why the surfaces warn first.

    Args:
        file: Input PDF path.
        output: Output PDF path (may equal `file`).
        categories: The category ids to remove. Never defaulted.
        form_fields_mode: "remove" drops the fields outright; "flatten" bakes
            their appearances into the page first, keeping the look.
        hidden_text_ocr: Also remove invisible text that is a recognition
            layer. Off by default: removing it makes a scan unsearchable.
        all_removable: Select every category except the ones that cost the
            document something. Those are named explicitly or not at all.
    """
    chosen = _selection(categories, all_removable)
    if form_fields_mode not in ("remove", "flatten"):
        raise ValueError("form_fields_mode must be 'remove' or 'flatten'.")

    before = audit_hidden_information(file)
    _refuse_unreadable(before)
    counts = {row["id"]: row["count"] for row in before["categories"]}
    fields_row = next(r for r in before["categories"] if r["id"] == "form_fields")
    if "form_fields" in chosen and fields_row.get("xfa"):
        raise ValueError(
            "This document contains an XML form (XFA). Removing its fields would leave "
            "the XFA packet describing a form the document no longer has, so form_fields "
            "cannot be sanitized here. Flatten the form with another tool first."
        )

    output_path = Path(output)
    same_file = is_same_file(file, output)
    removed = {cid: 0 for cid in CATEGORY_IDS}

    options = {"form_fields_mode": form_fields_mode, "hidden_text_ocr": bool(hidden_text_ocr)}
    with pikepdf.open(file) as pdf:
        # Report order is also apply order, and two pairs depend on it: hidden
        # layers are dropped before hidden text is re-analyzed, so the layer's
        # words are not looked for twice, and a flatten stamps its appearances
        # into the page before that analysis reads it.
        for category in sorted(chosen, key=CATEGORY_IDS.index):
            if category in FREE_FROM_SAVE:
                removed[category] = counts[category]
                continue
            removed[category] = REMOVERS[category](pdf, before, options)

        if same_file:
            staged = staging_target(output_path)
            save_pdf(pdf, staged)
        else:
            save_pdf(pdf, output_path)
    if same_file:
        finish_staged(staged, output_path)

    return {
        "output": str(output_path),
        "selected": chosen,
        "form_fields_mode": form_fields_mode,
        "hidden_text_ocr": bool(hidden_text_ocr),
        "categories": [
            {"id": cid, "removed": removed[cid], "selected": cid in chosen}
            for cid in CATEGORY_IDS
        ],
        "signatures_invalidated": before["signatures"]["count"] > 0,
    }
