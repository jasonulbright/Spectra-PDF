"""Write a PDF's text layer to a plain-text file.

Two orderings, because a page's reading sequence and its visual layout answer
different questions. pdfminer's default analysis flows text boxes into one
reading order; disabling `boxes_flow` orders them by position alone, which is
what a column-preserving transcription needs.

A page break is written as a form feed (U+000C), the separator text extractors
use, so a page-scoped transcription can be split back into pages.
"""

from __future__ import annotations

import io
from pathlib import Path

import pikepdf
from pdfminer.converter import TextConverter
from pdfminer.layout import LAParams
from pdfminer.pdfinterp import PDFPageInterpreter, PDFResourceManager
from pdfminer.pdfpage import PDFPage

LAYOUTS = ("reading", "layout")
PAGE_BREAK = "\f"


def _laparams(layout: str) -> LAParams:
    if layout == "layout":
        # boxes_flow disabled orders text boxes by position alone, so a
        # multi-column page transcribes column by column instead of being
        # interleaved into a single flow.
        return LAParams(boxes_flow=None)
    return LAParams()


def page_numbers(pages, pdf) -> list[int]:
    """The 1-based pages to transcribe.

    Spelled with `page_no` and `len(pdf.pages)` deliberately: the out-of-range
    refusal is a shared row in the engine-message table, and a differently named
    local would rename the interpolations of a message several modules raise.
    """
    if pages is None or pages == "all":
        return list(range(1, len(pdf.pages) + 1))
    if isinstance(pages, str):
        raise ValueError('pages must be a list of page numbers or "all"')
    out: list[int] = []
    for value in pages:
        page_no = int(value)
        if not (1 <= page_no <= len(pdf.pages)):
            raise ValueError(f"page {page_no} is out of range (1-{len(pdf.pages)})")
        if page_no not in out:
            out.append(page_no)
    return sorted(out)


def page_texts(file: str, wanted: list[int], layout: str) -> list[tuple[int, str]]:
    """Each wanted page's text, in document order.

    One interpreter over one open file: the sink's position before and after a
    page bounds that page's own output, so per-page text costs no extra parse.

    The converter terminates every page with a form feed of its own. It is
    stripped here so the page separator is this module's choice — left in, the
    unbroken layout would still carry page breaks and the broken one would carry
    two per boundary.
    """
    manager = PDFResourceManager()
    sink = io.StringIO()
    device = TextConverter(manager, sink, laparams=_laparams(layout))
    interpreter = PDFPageInterpreter(manager, device)
    out: list[tuple[int, str]] = []
    try:
        with open(file, "rb") as handle:
            selected = {number - 1 for number in wanted}
            for number, page in zip(wanted, PDFPage.get_pages(handle, selected)):
                mark = sink.tell()
                interpreter.process_page(page)
                sink.seek(mark)
                section = sink.read()
                if section.endswith(PAGE_BREAK):
                    section = section[: -len(PAGE_BREAK)]
                out.append((number, section))
    finally:
        device.close()
    return out


def export_text(
    file: str,
    output: str,
    pages="all",
    layout: str = "reading",
    page_breaks: bool = False,
) -> dict:
    """Transcribe ``file``'s text layer to ``output``.

    Args:
        file: input PDF path.
        output: destination ``.txt`` path.
        pages: list of 1-based page numbers, or 'all'.
        layout: 'reading' (flowed) or 'layout' (position-ordered).
        page_breaks: write a form feed between pages.
    """
    mode = str(layout or "reading").lower()
    if mode not in LAYOUTS:
        raise ValueError(f"unknown text layout {layout!r} (choose reading or layout)")

    with pikepdf.open(str(file)) as pdf:
        wanted = page_numbers(pages, pdf)

    extracted = page_texts(str(file), wanted, mode)
    sections = [text for _number, text in extracted]
    empty = [number for number, text in extracted if not text.strip()]
    if len(empty) == len(extracted):
        raise ValueError(
            "this document has no text layer, so there is nothing to export as "
            "text -- run OCR on it first to add one"
        )

    separator = PAGE_BREAK if page_breaks else ""
    body = separator.join(sections)
    out_path = Path(output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    # UTF-8 with no BOM and no newline translation: the file is a transcription,
    # and a BOM would be read back as a character by every consumer that does
    # not strip one.
    out_path.write_text(body, encoding="utf-8", newline="")
    return {
        "output": str(out_path),
        "format": "txt",
        "size": out_path.stat().st_size,
        "pages_extracted": wanted,
        "empty_pages": empty,
        "characters": len(body),
    }
