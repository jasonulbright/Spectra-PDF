"""Text extraction from PDF using pikepdf and pdfminer.six."""

import heapq
from io import StringIO
from pathlib import Path

from pdfminer.converter import PDFPageAggregator, TextConverter
from pdfminer.layout import (
    LAParams,
    LTChar,
    LTFigure,
    LTPage,
    LTTextBoxVertical,
    LTTextContainer,
    LTTextGroupLRTB,
    LTTextGroupTBRL,
)
from pdfminer.pdfinterp import PDFPageInterpreter, PDFResourceManager
from pdfminer.pdfpage import PDFPage
from pdfminer.pdftypes import PDFObjRef, dict_value, list_value, resolve1
from pdfminer.psparser import literal_name
from pdfminer.utils import Plane


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


class _DrawnOrderGrouping:
    """pdfminer's hierarchical grouping of text boxes
    (`LTLayoutContainer.group_textboxes`), with a tie between two equally
    distant pairs broken by the order the boxes were drawn in.

    pdfminer breaks that tie by `id()`, a memory address. Two loads of the same
    bytes get other addresses, in another order, so one page can read in two
    orders and a file compares as different from its exact copy. Here every box
    takes its place in the drawn order and every group the next number as it
    forms. No two queue entries then compare equal, so no comparison reaches
    the objects themselves.
    """

    def group_textboxes(self, laparams, boxes):
        plane = Plane(self.bbox)

        def dist(obj1, obj2) -> float:
            x0 = min(obj1.x0, obj2.x0)
            y0 = min(obj1.y0, obj2.y0)
            x1 = max(obj1.x1, obj2.x1)
            y1 = max(obj1.y1, obj2.y1)
            return (x1 - x0) * (y1 - y0) - obj1.width * obj1.height - obj2.width * obj2.height

        def isany(obj1, obj2) -> bool:
            x0 = min(obj1.x0, obj2.x0)
            y0 = min(obj1.y0, obj2.y0)
            x1 = max(obj1.x1, obj2.x1)
            y1 = max(obj1.y1, obj2.y1)
            return bool(set(plane.find((x0, y0, x1, y1))).difference((obj1, obj2)))

        serial = {box: n for n, box in enumerate(boxes)}
        queue = [
            (False, dist(boxes[i], boxes[j]), i, j, boxes[i], boxes[j])
            for i in range(len(boxes))
            for j in range(i + 1, len(boxes))
        ]
        heapq.heapify(queue)
        plane.extend(boxes)
        done = set()
        while queue:
            skip_isany, d, n1, n2, obj1, obj2 = heapq.heappop(queue)
            if n1 in done or n2 in done:
                continue
            if not skip_isany and isany(obj1, obj2):
                heapq.heappush(queue, (True, d, n1, n2, obj1, obj2))
                continue
            if isinstance(obj1, (LTTextBoxVertical, LTTextGroupTBRL)) or isinstance(
                obj2, (LTTextBoxVertical, LTTextGroupTBRL)
            ):
                group = LTTextGroupTBRL([obj1, obj2])
            else:
                group = LTTextGroupLRTB([obj1, obj2])
            plane.remove(obj1)
            plane.remove(obj2)
            done.update((n1, n2))
            number = len(serial)
            serial[group] = number
            for other in plane:
                heapq.heappush(queue, (False, dist(group, other), number, serial[other], group, other))
            plane.add(group)
        return list(plane)


class _DrawnOrderPage(_DrawnOrderGrouping, LTPage):
    pass


class _DrawnOrderFigure(_DrawnOrderGrouping, LTFigure):
    pass


class _DrawnOrderLayout:
    """A pdfminer layout device whose pages and figures group their text boxes
    in drawn order. pdfminer builds each container; only its class changes."""

    def begin_page(self, page, ctm) -> None:
        super().begin_page(page, ctm)
        self.cur_item.__class__ = _DrawnOrderPage

    def begin_figure(self, name, bbox, matrix) -> None:
        super().begin_figure(name, bbox, matrix)
        self.cur_item.__class__ = _DrawnOrderFigure


class LayoutTextConverter(_DrawnOrderLayout, TextConverter):
    """pdfminer's `TextConverter` with drawn-order grouping."""


class LayoutPageAggregator(_DrawnOrderLayout, PDFPageAggregator):
    """pdfminer's `PDFPageAggregator` with drawn-order grouping."""


def pdfminer_text(file: str, page_numbers=None, laparams: LAParams | None = None) -> str:
    """pdfminer's `high_level.extract_text`, read through `TextStateInterpreter`.
    `page_numbers` are 0-based, as pdfminer's are."""
    with open(file, "rb") as handle, StringIO() as sink:
        manager = PDFResourceManager(caching=True)
        device = LayoutTextConverter(manager, sink, codec="utf-8", laparams=laparams or LAParams())
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
        device = LayoutPageAggregator(manager, laparams=laparams or LAParams())
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
