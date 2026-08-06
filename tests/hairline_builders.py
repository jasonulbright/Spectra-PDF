"""Constructed stroke-width fixtures.

Shared by the hairline tests and the end-to-end fixture builder: both measure
against a page whose stroke widths are known by construction, and the last
stroke is the case the raw operand hides — a `1 w` under a tenth-scale
transform, which draws 0.1 pt and lists as 1.0.
"""

from __future__ import annotations

import pikepdf
from pikepdf import Dictionary

# The widths drawn, in order, one horizontal rule each.
LADDER_WIDTHS = (0.0, 0.05, 0.1, 0.24, 0.25, 0.5, 1.0)

# The scale the last stroke is drawn under, and the operand it uses.
SCALED_CTM = 0.1
SCALED_OPERAND = 1.0


def hairline_ladder_pdf(path):
    """A page of rules at every ladder width, plus the scaled-CTM case."""
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(400, 300))
    page.Resources = Dictionary()
    lines = [
        f"{width} w 20 {20 + index * 20} m 380 {20 + index * 20} l S".encode()
        for index, width in enumerate(LADDER_WIDTHS)
    ]
    y = int((20 + len(LADDER_WIDTHS) * 20) / SCALED_CTM)
    lines.append(
        f"q {SCALED_CTM} 0 0 {SCALED_CTM} 0 0 cm {SCALED_OPERAND} w "
        f"200 {y} m 3800 {y} l S Q".encode()
    )
    page.Contents = pdf.make_stream(b"\n".join(lines))
    pdf.save(path)
    pdf.close()
    return str(path)
