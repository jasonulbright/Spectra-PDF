"""Reading order of rotated text through the engine's pdfminer layout path."""

import math

import pikepdf
import pytest

from engine.extract_text import pdfminer_pages, pdfminer_text
from engine.text_export import page_texts


def _line(text: str, angle: float, x: float, y: float, reflected: bool = False) -> str:
    theta = math.radians(angle)
    a, b = math.cos(theta), math.sin(theta)
    c, d = -b, a
    if reflected:
        c, d = -c, -d
    return f"BT /F1 12 Tf {a:.6f} {b:.6f} {c:.6f} {d:.6f} {x} {y} Tm ({text}) Tj ET\n"


def _pdf(path, content: str, rotate: int = 0) -> str:
    pdf = pikepdf.new()
    font = pdf.make_indirect(
        pikepdf.Dictionary(Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1, BaseFont=pikepdf.Name.Helvetica)
    )
    page = pdf.add_blank_page(page_size=(612, 792))
    page.obj.Resources = pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=font))
    page.obj.Contents = pdf.make_stream(content.encode("latin-1"))
    if rotate:
        page.obj.Rotate = rotate
    pdf.save(str(path))
    return str(path)


def _lines(text: str) -> list[str]:
    return [line.strip() for line in text.splitlines() if line.strip()]


def _offset(angle: float, step: float) -> tuple[float, float]:
    """The device displacement of one line down in a frame rotated by `angle`."""
    theta = math.radians(angle)
    return step * math.sin(theta), -step * math.cos(theta)


# Lines are drawn last-first so drawn order never agrees with reading order.
@pytest.mark.parametrize("angle", [0, 90, 180, 270, 30, 135, 315])
def test_rotated_lines_read_in_their_own_order(tmp_path, angle):
    origin = (306.0, 396.0)
    words = ["First line here", "Second line here", "Third line here"]
    content = ""
    for index in reversed(range(len(words))):
        dx, dy = _offset(angle, 20.0 * index)
        content += _line(words[index], angle, origin[0] + dx, origin[1] + dy)
    path = _pdf(tmp_path / f"rot{angle}.pdf", content)
    assert _lines(pdfminer_text(path)) == words


@pytest.mark.parametrize("rotate", [90, 180, 270])
def test_page_rotate_reads_upright_content(tmp_path, rotate):
    content = _line("Second line", 0, 72, 680) + _line("First line", 0, 72, 700)
    path = _pdf(tmp_path / f"page{rotate}.pdf", content, rotate=rotate)
    assert _lines(pdfminer_text(path)) == ["First line", "Second line"]


def test_mixed_orientations_read_each_line_whole(tmp_path):
    body = ["Body line one", "Body line two", "Body line three"]
    content = _line("Sidebar label", 90, 40, 300)
    for index, text in enumerate(body):
        content += _line(text, 0, 100, 700 - 20 * index)
    path = _pdf(tmp_path / "mixed.pdf", content)
    assert _lines(pdfminer_text(path)) == body + ["Sidebar label"]


def test_rotated_boxes_keep_device_bounds(tmp_path):
    path = _pdf(tmp_path / "bounds.pdf", _line("Vertical", 90, 200, 300))
    (layout,) = list(pdfminer_pages(path))
    boxes = [obj for obj in layout if hasattr(obj, "get_text")]
    assert len(boxes) == 1
    box = boxes[0]
    assert box.get_text().strip() == "Vertical"
    assert box.height > box.width
    assert 188 < box.x0 < 200 < box.x1 < 204
    assert box.y0 == pytest.approx(300, abs=0.5)


def test_reflected_text_reads_along_its_own_glyph_down_axis(tmp_path):
    content = _line("Mirror two", 0, 72, 680, reflected=True) + _line("Mirror one", 0, 72, 700, reflected=True)
    path = _pdf(tmp_path / "mirror.pdf", content)
    assert _lines(pdfminer_text(path)) == ["Mirror two", "Mirror one"]


@pytest.mark.parametrize("layout", ["reading", "layout"])
def test_export_orders_rotated_text(tmp_path, layout):
    content = _line("Line B", 180, 400, 420) + _line("Line A", 180, 400, 400)
    path = _pdf(tmp_path / "export.pdf", content)
    ((_number, text),) = page_texts(path, [1], layout)
    assert _lines(text) == ["Line A", "Line B"]


def test_near_upright_lines_keep_top_to_bottom_order(tmp_path):
    words = [f"Scanned line {n}" for n in range(1, 7)]
    tilts = [0.4, -0.6, 0.6, -0.4, 1.2, -1.1]
    content = ""
    for index in reversed(range(len(words))):
        content += _line(words[index], tilts[index], 72, 700 - 18 * index)
    path = _pdf(tmp_path / "deskewed.pdf", content)
    assert _lines(pdfminer_text(path)) == words


def _arc_label(text: str, first: float, step: float) -> str:
    centre, radius = (306.0, 200.0), 200.0
    content = ""
    for index, glyph in enumerate(text):
        angle = first - step * index
        phi = math.radians(angle + 90.0)
        x = centre[0] + radius * math.cos(phi)
        y = centre[1] + radius * math.sin(phi)
        content += _line(glyph, angle, round(x, 3), round(y, 3))
    return content


def test_arc_label_reads_whole_in_one_pass(tmp_path, monkeypatch):
    from pdfminer.layout import LTLayoutContainer

    from engine import extract_text as module

    passes = []
    original = LTLayoutContainer.analyze

    def counted(self, laparams):
        if isinstance(self, module._Frame):
            passes.append(self)
        return original(self, laparams)

    monkeypatch.setattr(LTLayoutContainer, "analyze", counted)
    content = _line("Body text", 0, 72, 740) + _arc_label("ARCLABEL", 51.0, 3.0)
    path = _pdf(tmp_path / "arc.pdf", content)
    lines = _lines(pdfminer_text(path))
    assert lines[0] == "Body text"
    assert "".join("".join(lines[1:]).split()) == "ARCLABEL"
    assert len(passes) == 2


def test_stray_off_axis_glyph_reads_with_upright_text(tmp_path, monkeypatch):
    from pdfminer.layout import LTLayoutContainer

    from engine import extract_text as module

    passes = []
    original = LTLayoutContainer.analyze

    def counted(self, laparams):
        if isinstance(self, module._Frame):
            passes.append(self)
        return original(self, laparams)

    monkeypatch.setattr(LTLayoutContainer, "analyze", counted)
    content = _line("Upright words", 0, 72, 700) + _line("x", 45, 300, 400)
    path = _pdf(tmp_path / "stray.pdf", content)
    assert _lines(pdfminer_text(path))[0] == "Upright words"
    assert passes == []
