"""The three pages every content walker is checked against for the font the
text state holds (ISO 32000-2 §9.3.1).

  A   an ExtGState /Font entry sets the font and the size, with no Tf
      (Table 57);
  A2  the same ExtGState after a Tf of another font at 1 pt;
  B   a form inherits the page's font dictionary while its own resources give
      the same name to another font (§8.10.1).

Each page draws "PUBLIC SECRET WORDS" from x = 60 on the baseline y = 300 at
12 pt. The drawing font advances 0.6 em per character and its descriptor
declares an ink extent of 0.2 em below and 0.7 em above the baseline, so the
run's ink box is `INK_BOX`. The font a name lookup finds instead declares no
extent (A2: 0.6 em at 1 pt; B: 0.05 em at 12 pt; A: none at all).
"""

from __future__ import annotations

import os

from pikepdf import Array, Dictionary, Name

from test_redact_text_state import TEXT, _form_doc, _gs_font_doc

SHAPES = ("A", "A2", "B")
INK_BOX = (60.0, 297.6, 196.8, 308.4)


def _describe(doc, font) -> None:
    font["/FontDescriptor"] = doc.make_indirect(
        Dictionary(
            Type=Name.FontDescriptor, FontName=Name("/Wide"), Flags=32,
            FontBBox=Array([0, -200, 600, 700]), ItalicAngle=0,
            Ascent=700, Descent=-200, CapHeight=700, StemV=80,
        )
    )


def shape_doc(label: str):
    """The open pikepdf document of one shape."""
    if label == "A":
        doc = _gs_font_doc()
        _describe(doc, doc.pages[0].Resources.ExtGState.GS1.Font[0])
    elif label == "A2":
        doc = _gs_font_doc(b"/F2 1 Tf ")
        _describe(doc, doc.pages[0].Resources.ExtGState.GS1.Font[0])
    elif label == "B":
        doc = _form_doc()
        _describe(doc, doc.pages[0].Resources.Font.F1)
    else:
        raise ValueError(label)
    return doc


def shape_pdf(directory: str, label: str, extra: bytes = b"") -> str:
    """One shape saved to `directory`, with `extra` appended to the page's
    own content stream."""
    doc = shape_doc(label)
    if extra:
        page = doc.pages[0]
        page.Contents = doc.make_stream(page.Contents.read_bytes() + b"\n" + extra)
    path = os.path.join(directory, f"shape_{label}.pdf")
    doc.save(path)
    doc.close()
    return path


__all__ = ["INK_BOX", "SHAPES", "TEXT", "shape_doc", "shape_pdf"]
