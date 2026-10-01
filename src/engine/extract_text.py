"""Text extraction from PDF using pikepdf and pdfminer.six."""

import heapq
from io import StringIO
from pathlib import Path

from pdfminer.converter import PDFPageAggregator, TextConverter
from pdfminer.layout import (
    LAParams,
    LTChar,
    LTFigure,
    LTLayoutContainer,
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

from engine.inplace import write_text_staged
from engine.reading_order import UPRIGHT, orientation, partition, rotation_degrees, to_frame
from engine.credentials import document_password, require_permission


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


def _orientation(char: LTChar) -> tuple[float, bool]:
    """The device-space direction a character's pen advances, and whether its
    glyph space is reflected. pdfminer folds the page's /Rotate into the
    initial CTM, so the matrix is already in display space."""
    a, b, c, d = char.matrix[0], char.matrix[1], char.matrix[2], char.matrix[3]
    return orientation(a, b, c, d, vertical=getattr(char, "vertical", False))


def _scalars(char: LTChar) -> int:
    """Unicode scalars a character contributes to its orientation's count:
    one drawn glyph whose /ToUnicode entry maps to several scalars counts each
    of them, the unit the renderer's reading order counts in. A glyph with no
    Unicode mapping counts one."""
    text = char.get_text()
    if text.startswith("(cid:") and text.endswith(")"):
        return 1
    return len(text)


def _refit(container) -> None:
    """Every text container under `container` bounds exactly its own
    children again, after the characters took back their device bounds."""
    bounded = []
    for child in container:
        if isinstance(child, LTTextContainer):
            _refit(child)
        if hasattr(child, "x0"):
            bounded.append(child)
    if bounded:
        container.set_bbox(
            (
                min(child.x0 for child in bounded),
                min(child.y0 for child in bounded),
                max(child.x1 for child in bounded),
                max(child.y1 for child in bounded),
            )
        )


class _Frame(_DrawnOrderGrouping, LTLayoutContainer):
    """The characters of one orientation, laid out by pdfminer's analysis in
    that orientation's upright frame."""


class _OrientedAnalysis:
    """pdfminer's layout analysis, run once per text orientation.

    pdfminer groups characters into lines by their device-space bounds, so it
    reads only text whose baseline runs left to right on the device: a page
    with /Rotate, text drawn at 90, 180, 270 or any other angle, or a column
    in a vertical writing mode reads one character per line or with its lines
    reversed. Here the characters are partitioned by the direction their pen
    advances, and each part is analysed in the frame where that direction runs
    left to right; the resulting lines and boxes then take back device-space
    bounds. Parts read in `reading_order.partition`'s order, so the
    orientation that carries most of the page leads and a rotated side label
    follows it. A page whose text is all upright takes pdfminer's analysis
    unchanged.
    """

    def analyze(self, laparams) -> None:
        if isinstance(self, LTFigure) and not laparams.all_texts:
            return
        parts = partition([obj for obj in self if isinstance(obj, LTChar)], _orientation, _scalars)
        if not parts or [key for key, _chars in parts] == [UPRIGHT]:
            LTLayoutContainer.analyze(self, laparams)
            return
        others = [obj for obj in self if not isinstance(obj, LTChar)]
        for obj in others:
            obj.analyze(laparams)
        laid_out = []
        for key, chars in parts:
            device = [(char.x0, char.y0, char.x1, char.y1) for char in chars]
            for char in chars:
                char.set_bbox(to_frame(char.bbox, key))
            frame = _Frame(to_frame(self.bbox, key))
            frame.extend(chars)
            LTLayoutContainer.analyze(frame, laparams)
            for char, bbox in zip(chars, device):
                char.set_bbox(bbox)
            for obj in frame:
                if isinstance(obj, LTTextContainer):
                    _refit(obj)
                laid_out.append(obj)
        self.groups = None
        self._objs = laid_out + others


class _DrawnOrderPage(_OrientedAnalysis, _DrawnOrderGrouping, LTPage):
    pass


class _DrawnOrderFigure(_OrientedAnalysis, _DrawnOrderGrouping, LTFigure):
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

    def render_char(self, matrix, font, fontsize, scaling, rise, cid, ncs, graphicstate) -> float:
        """pdfminer's character, marked with its font's writing mode: a
        character of a vertical font advances down its glyph space, which its
        matrix alone does not say."""
        advance = super().render_char(matrix, font, fontsize, scaling, rise, cid, ncs, graphicstate)
        self.cur_item._objs[-1].vertical = font.is_vertical()
        return advance


class LayoutTextConverter(_DrawnOrderLayout, TextConverter):
    """pdfminer's `TextConverter` with drawn-order grouping."""


class LayoutPageAggregator(_DrawnOrderLayout, PDFPageAggregator):
    """pdfminer's `PDFPageAggregator` with drawn-order grouping."""


def document_pages(handle, file, page_numbers=None, caching: bool = True):
    """`PDFPage.get_pages` over `handle`, the open bytes of `file`, with the
    stored password of `file`. Every pdfminer read in the engine goes through
    here: pdfminer tries only the empty password, and a document opened with
    its user password raises `PDFPasswordIncorrect` without it.

    Each page's rotation is `reading_order.rotation_degrees` of its /Rotate:
    pdfminer reads a real-valued /Rotate as 0, which the renderer displays
    rotated."""
    password = document_password(file) or ""
    for page in PDFPage.get_pages(handle, page_numbers, password=password, caching=caching):
        page.rotate = rotation_degrees(resolve1(page.attrs.get("Rotate", 0)))
        yield page


def layout_params(**overrides) -> LAParams:
    """pdfminer's layout parameters as every engine reader takes them. Text
    a form XObject draws is laid out like the page's own (`all_texts`):
    without it pdfminer emits a form's characters in drawn order with no line
    or word breaks, and an OCR text layer, which lives in a form, reads as
    one run of glued words."""
    return LAParams(all_texts=True, **overrides)


def pdfminer_text(file: str, page_numbers=None, laparams: LAParams | None = None) -> str:
    """pdfminer's `high_level.extract_text`, read through `TextStateInterpreter`.
    `page_numbers` are 0-based, as pdfminer's are."""
    with open(file, "rb") as handle, StringIO() as sink:
        manager = PDFResourceManager(caching=True)
        device = LayoutTextConverter(manager, sink, codec="utf-8", laparams=laparams or layout_params())
        interpreter = TextStateInterpreter(manager, device)
        for page in document_pages(handle, file, page_numbers):
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
        device = LayoutPageAggregator(manager, laparams=laparams or layout_params())
        interpreter = TextStateInterpreter(manager, device)
        for page in document_pages(handle, file, page_numbers):
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
    require_permission(file, "copy")
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
        write_text_staged(out_path, text, newline="")
        result["output"] = str(out_path)
    return result
