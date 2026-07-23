"""Accessibility checker (§ I.6).

Reports how well a PDF meets the baseline accessibility requirements the king's
checker enforces (PDF/UA-adjacent): is it tagged, does it declare a language,
does it have a title shown in the window bar, is its text actually extractable
(not an un-OCR'd scan), and does it offer navigation. Read-only — it REPORTS;
fixing is the metadata/OCR tools' job.

Each check returns pass / warn / fail with a human explanation, so the panel
can show a checklist the way Acrobat's Accessibility Checker does.
"""

import pikepdf
from pikepdf import Name

from engine.extract_text import extract_text


def _meta_title(pdf) -> str:
    # docinfo /Title first, then XMP dc:title.
    try:
        info = pdf.docinfo
        t = info.get("/Title")
        if t is not None and str(t).strip():
            return str(t).strip()
    except Exception:
        pass
    try:
        with pdf.open_metadata() as meta:
            t = meta.get("dc:title")
            if t:
                return str(t).strip()
    except Exception:
        pass
    return ""


def _is_tagged(pdf) -> bool:
    root = pdf.Root
    marked = False
    mi = root.get("/MarkInfo")
    if mi is not None:
        try:
            marked = bool(mi.get("/Marked"))
        except Exception:
            marked = False
    return marked and root.get("/StructTreeRoot") is not None


def _display_doc_title(pdf) -> bool:
    vp = pdf.Root.get("/ViewerPreferences")
    if vp is None:
        return False
    try:
        return bool(vp.get("/DisplayDocTitle"))
    except Exception:
        return False


def _has_text(file: str) -> bool:
    try:
        return len(extract_text(file)["text"].strip()) > 0
    except Exception:
        return False


def check_accessibility(file: str) -> dict:
    """Run the baseline accessibility checks; return per-check results + a
    pass/total summary."""
    checks = []

    def add(cid, label, status, detail):
        checks.append({"id": cid, "label": label, "status": status, "detail": detail})

    with pikepdf.open(file) as pdf:
        total_pages = len(pdf.pages)

        tagged = _is_tagged(pdf)
        add(
            "tagged", "Document is tagged",
            "pass" if tagged else "fail",
            "Structure tags let assistive technology read content in order."
            if tagged else "No /StructTreeRoot with /MarkInfo /Marked — the document is untagged.",
        )

        lang = ""
        try:
            lv = pdf.Root.get("/Lang")
            lang = str(lv).strip() if lv is not None else ""
        except Exception:
            lang = ""
        add(
            "lang", "Document language is set",
            "pass" if lang else "fail",
            f"Language is '{lang}'." if lang else "No /Lang — screen readers can't pick the right voice.",
        )

        title = _meta_title(pdf)
        add(
            "title", "Document has a title",
            "pass" if title else "fail",
            f"Title is '{title}'." if title else "No title in the metadata.",
        )

        shows_title = _display_doc_title(pdf)
        add(
            "display_title", "Title is shown in the window bar",
            "pass" if shows_title else "warn",
            "DisplayDocTitle is on." if shows_title
            else "ViewerPreferences /DisplayDocTitle is off — the window shows the file name, not the title.",
        )

        has_text = _has_text(file)
        add(
            "text", "Text is extractable (not an un-OCR'd scan)",
            "pass" if has_text else "fail",
            "The document has extractable text." if has_text
            else "No extractable text — a scanned document needs OCR before it can be read aloud.",
        )

        has_outline = pdf.Root.get("/Outlines") is not None
        if total_pages >= 10:
            add(
                "bookmarks", "Long document has bookmarks",
                "pass" if has_outline else "warn",
                "Bookmarks are present." if has_outline
                else f"{total_pages} pages and no bookmarks — navigation is harder without them.",
            )

    passed = sum(1 for c in checks if c["status"] == "pass")
    failed = sum(1 for c in checks if c["status"] == "fail")
    return {
        "checks": checks,
        "passed": passed,
        "failed": failed,
        "warnings": sum(1 for c in checks if c["status"] == "warn"),
        "total": len(checks),
    }
