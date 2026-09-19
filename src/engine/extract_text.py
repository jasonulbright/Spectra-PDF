"""Text extraction from PDF using pikepdf and pdfminer.six."""

from io import StringIO
from pathlib import Path

from pdfminer.converter import PDFPageAggregator, TextConverter
from pdfminer.layout import LAParams, LTChar, LTFigure, LTTextContainer
from pdfminer.pdfinterp import PDFPageInterpreter, PDFResourceManager
from pdfminer.pdfpage import PDFPage
from pdfminer.pdftypes import PDFObjRef, dict_value, list_value, resolve1
from pdfminer.psparser import literal_name


class TextStateInterpreter(PDFPageInterpreter):
    """pdfminer's page interpreter with the text state ISO 32000-2 defines.

    An ExtGState /Font entry sets the font and the size as `Tf` does (Table
    57), and a form XObject starts in the text state of the Do that draws it
    (§8.10.1). pdfminer's own interpreter ignores the first and starts every
    form from an empty text state, so text drawn either way extracts as
    nothing. Every engine caller of pdfminer's layout analysis reads pages
    through this class.
    """

    inherited = None

    def subinterp(self):
        interpreter = super().subinterp()
        interpreter.inherited = self.textstate
        return interpreter

    def init_state(self, ctm) -> None:
        super().init_state(ctm)
        if self.inherited is not None:
            self.textstate = self.inherited.copy()
            self.textstate.reset()

    def do_gs(self, name) -> None:
        try:
            states = dict_value(self.resources.get("ExtGState"))
            state = dict_value(states.get(literal_name(name)))
            entry = list_value(state.get("Font"))
            font_ref, size = entry[0], float(resolve1(entry[1]))
            objid = font_ref.objid if isinstance(font_ref, PDFObjRef) else None
            font = self.rsrcmgr.get_font(objid, dict_value(font_ref))
        except Exception:
            return
        self.textstate.font = font
        self.textstate.fontsize = size


def pdfminer_text(file: str, page_numbers=None, laparams: LAParams | None = None) -> str:
    """pdfminer's `high_level.extract_text`, read through `TextStateInterpreter`.
    `page_numbers` are 0-based, as pdfminer's are."""
    with open(file, "rb") as handle, StringIO() as sink:
        manager = PDFResourceManager(caching=True)
        device = TextConverter(manager, sink, codec="utf-8", laparams=laparams or LAParams())
        interpreter = TextStateInterpreter(manager, device)
        for page in PDFPage.get_pages(handle, page_numbers, caching=True):
            interpreter.process_page(page)
        return sink.getvalue()


def layout_text(layout) -> str:
    """The text of one laid-out page: every text box in layout order, and the
    text inside every figure. pdfminer lays out a form XObject's content as a
    figure and leaves its characters out of the page's text boxes, so reading
    the boxes alone drops every word a form draws."""
    parts: list[str] = []

    def visit(element) -> None:
        if isinstance(element, LTTextContainer):
            parts.append(element.get_text())
        elif isinstance(element, LTChar):
            parts.append(element.get_text())
        elif isinstance(element, LTFigure):
            for child in element:
                visit(child)

    for element in layout:
        visit(element)
    return "".join(parts)


def pdfminer_pages(file: str, page_numbers=None, laparams: LAParams | None = None):
    """pdfminer's `high_level.extract_pages`, read through
    `TextStateInterpreter`: one laid-out page (`LTPage`) per page."""
    with open(file, "rb") as handle:
        manager = PDFResourceManager(caching=True)
        device = PDFPageAggregator(manager, laparams=laparams or LAParams())
        interpreter = TextStateInterpreter(manager, device)
        for page in PDFPage.get_pages(handle, page_numbers, caching=True):
            interpreter.process_page(page)
            yield device.get_result()


def extract_text(file: str, pages: list[int] | str = "all", output: str | None = None) -> dict:
    """Extract text from a PDF.

    Args:
        file: Input PDF path.
        pages: List of 1-based page numbers, or 'all'.
        output: optional destination path; the extracted text is written there
            as UTF-8 with no BOM and the path is reported back.
    """
    page_numbers = None
    if pages != "all":
        # pdfminer uses 0-based page indices
        page_numbers = set(p - 1 for p in pages)

    text = pdfminer_text(file, page_numbers=page_numbers)

    result = {
        "file": file,
        "text": text,
        "length": len(text),
        "pages_extracted": "all" if page_numbers is None else len(page_numbers),
    }
    if output is not None and str(output).strip():
        out_path = Path(output)
        if out_path.is_dir():
            raise ValueError(f"output path is a directory, not a file: {output}")
        out_path.parent.mkdir(parents=True, exist_ok=True)
        # No BOM and no newline translation: the file is a transcription, and a
        # BOM would be read back as a character by every consumer that does not
        # strip one.
        out_path.write_text(text, encoding="utf-8", newline="")
        result["output"] = str(out_path)
    return result
