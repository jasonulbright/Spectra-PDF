"""Text extraction from PDF using pikepdf and pdfminer.six."""

import heapq
import math
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


AXIS_TOLERANCE = 3.0
"""Degrees within which an angle counts as the nearest multiple of 90: a
deskewed scan's text layer leans by a fraction of a degree per line."""

CHAIN_TOLERANCE = 8.0
"""Degrees between neighbouring off-axis angles that still read as one
orientation: text set on an arc turns a few degrees per glyph."""

MIN_ORIENTED_CHARS = 3
"""An off-axis orientation with fewer characters reads with the upright text,
so a stray glyph costs no layout pass of its own."""


def _orientation(char: LTChar) -> tuple[float, bool]:
    """The rotation of a character's glyph space in device space, in degrees
    counter-clockwise in [0, 360), and whether that space is reflected.

    The glyph x axis of the text rendering matrix is the direction a
    horizontal font advances along its baseline (ISO 32000-2 §9.4.4). The
    matrix already carries the CTM, and pdfminer folds the page's /Rotate
    (§7.7.3.3) into the initial CTM, so page rotation and text-matrix rotation
    arrive as one angle."""
    a, b, c, d = char.matrix[0], char.matrix[1], char.matrix[2], char.matrix[3]
    if a == 0 and b == 0:
        return 0.0, False
    angle = math.degrees(math.atan2(b, a)) % 360.0
    return angle, a * d - b * c < 0


def _circular_mean(angles: list[float]) -> float:
    x = sum(math.cos(math.radians(angle)) for angle in angles)
    y = sum(math.sin(math.radians(angle)) for angle in angles)
    return round(math.degrees(math.atan2(y, x)) % 360.0, 6)


def _partition(chars: list[LTChar]) -> dict[tuple[float, bool], list[LTChar]]:
    """The characters grouped by reading orientation.

    An angle within `AXIS_TOLERANCE` of a multiple of 90 is that multiple.
    Other angles of one reflection sort around the circle and chain while
    neighbours lie within `CHAIN_TOLERANCE`; a chain reads in the frame of its
    mean angle. A chain under `MIN_ORIENTED_CHARS` joins the upright group."""
    parts: dict[tuple[float, bool], list[LTChar]] = {}
    loose: dict[bool, list[tuple[float, LTChar]]] = {}
    for char in chars:
        angle, reflected = _orientation(char)
        axis = (round(angle / 90.0) * 90) % 360
        if abs(((angle - axis + 180.0) % 360.0) - 180.0) <= AXIS_TOLERANCE:
            parts.setdefault((float(axis), reflected), []).append(char)
        else:
            loose.setdefault(reflected, []).append((angle, char))
    strays: list[LTChar] = []
    for reflected in sorted(loose):
        entries = sorted(loose[reflected], key=lambda entry: entry[0])
        chains = [[entries[0]]]
        for entry in entries[1:]:
            if entry[0] - chains[-1][-1][0] <= CHAIN_TOLERANCE:
                chains[-1].append(entry)
            else:
                chains.append([entry])
        if len(chains) > 1 and entries[0][0] + 360.0 - entries[-1][0] <= CHAIN_TOLERANCE:
            chains[0] = chains.pop() + chains[0]
        for chain in chains:
            members = [char for _angle, char in chain]
            if len(members) < MIN_ORIENTED_CHARS:
                strays.extend(members)
                continue
            key = (_circular_mean([angle for angle, _char in chain]), reflected)
            parts.setdefault(key, []).extend(members)
    if strays:
        parts.setdefault((0.0, False), []).extend(strays)
    order = {id(char): n for n, char in enumerate(chars)}
    for members in parts.values():
        members.sort(key=lambda char: order[id(char)])
    return parts


def _to_frame(box, angle: float, reflected: bool) -> tuple[float, float, float, float]:
    """`box` in the frame where text of orientation (`angle`, `reflected`)
    runs left to right with its glyph tops up: the axis-aligned bounds of the
    box's corners rotated by `-angle`, then mirrored top to bottom when the
    glyph space is reflected."""
    theta = math.radians(angle)
    cos, sin = math.cos(theta), math.sin(theta)
    xs, ys = [], []
    for x, y in ((box[0], box[1]), (box[0], box[3]), (box[2], box[1]), (box[2], box[3])):
        u = x * cos + y * sin
        v = -x * sin + y * cos
        xs.append(u)
        ys.append(-v if reflected else v)
    return min(xs), min(ys), max(xs), max(ys)


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
    with /Rotate, or text drawn at 90, 180, 270 or any other angle, reads one
    character per line or with its lines reversed. Here the characters are
    partitioned by orientation, and each part is analysed in the frame where
    its own baselines run left to right; the resulting lines and boxes then
    take back device-space bounds. Parts read in descending order of their
    character count, so the orientation that carries most of the page leads
    and a rotated side label follows it; equal counts read in ascending
    angle. A page whose text is all upright takes pdfminer's analysis
    unchanged.
    """

    def analyze(self, laparams) -> None:
        if isinstance(self, LTFigure) and not laparams.all_texts:
            return
        parts = _partition([obj for obj in self if isinstance(obj, LTChar)])
        if not parts or list(parts) == [(0.0, False)]:
            LTLayoutContainer.analyze(self, laparams)
            return
        others = [obj for obj in self if not isinstance(obj, LTChar)]
        for obj in others:
            obj.analyze(laparams)
        order = sorted(parts, key=lambda key: (-len(parts[key]), key[0], key[1]))
        laid_out = []
        for key in order:
            chars = parts[key]
            device = [(char.x0, char.y0, char.x1, char.y1) for char in chars]
            for char in chars:
                char.set_bbox(_to_frame(char.bbox, *key))
            frame = _Frame(_to_frame(self.bbox, *key))
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


class LayoutTextConverter(_DrawnOrderLayout, TextConverter):
    """pdfminer's `TextConverter` with drawn-order grouping."""


class LayoutPageAggregator(_DrawnOrderLayout, PDFPageAggregator):
    """pdfminer's `PDFPageAggregator` with drawn-order grouping."""


def document_pages(handle, file, page_numbers=None, caching: bool = True):
    """`PDFPage.get_pages` over `handle`, the open bytes of `file`, with the
    stored password of `file`. Every pdfminer read in the engine goes through
    here: pdfminer tries only the empty password, and a document opened with
    its user password raises `PDFPasswordIncorrect` without it."""
    password = document_password(file) or ""
    return PDFPage.get_pages(handle, page_numbers, password=password, caching=caching)


def pdfminer_text(file: str, page_numbers=None, laparams: LAParams | None = None) -> str:
    """pdfminer's `high_level.extract_text`, read through `TextStateInterpreter`.
    `page_numbers` are 0-based, as pdfminer's are."""
    with open(file, "rb") as handle, StringIO() as sink:
        manager = PDFResourceManager(caching=True)
        device = LayoutTextConverter(manager, sink, codec="utf-8", laparams=laparams or LAParams())
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
        device = LayoutPageAggregator(manager, laparams=laparams or LAParams())
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
