"""Build the F1a end-to-end fixtures: `xfa-static.pdf` and `xfa-dynamic.pdf`.

Both are HYBRID documents in the shape the wild population uses — real page
content, a complete AcroForm field shadow, and an `/XFA` array carrying the
template and datasets packets plus two the fill must never touch
(`connectionSet`, `xfdf`). The datasets tree is deliberately FLATTER than the
field names (no `Page1` node) and written in the wild's line-broken tag style,
so the spec drives the relaxed SOM walk and the byte-splice editor rather than
a tree that happens to match.

`name1` carries a value in the datasets packet and NO `/V` on its field
object: that is the F34 class — a value a reader that understands XFA shows
and this app used to report blank.

The dynamic one differs only by the catalog's `NeedsRendering` (ISO 32000-2
Table 29), which is what classification actually keys on.

Run from the repo root:
    .venv/Scripts/python.exe e2e-tests/fixtures/make-xfa-fixtures.py
"""

from pathlib import Path

import pikepdf
from pikepdf import Dictionary, Name

HERE = Path(__file__).parent

# The wild datasets style: every tag broken before its `>`. Any DOM round-trip
# rewrites this wholesale, which is why the editor splices bytes.
DATASETS = (
    b'<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"\n'
    b"><xfa:data\n"
    b"><topmostSubform\n"
    b"><name1\n"
    b">Ada</name1\n"
    b"><name2\n"
    b"/><group1 xfa:dataNode=\"dataGroup\"\n"
    b"><inner1\n"
    b">Lovelace</inner1\n"
    b"></group1\n"
    b"></topmostSubform\n"
    b"></xfa:data\n"
    b"></xfa:datasets\n"
    b">"
)

TEMPLATE = (
    b'<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/">'
    b'<subform name="topmostSubform"><field name="name1"><calculate>'
    b"<script>1</script></calculate></field></subform></template>"
)

CONNECTION_SET = (
    b'<connectionSet xmlns="http://www.xfa.org/schema/xfa-connection-set/2.8/">'
    b'<wsdlConnection name="svc" dataDescription="d"><wsdlAddress>'
    b"http://example.invalid/svc</wsdlAddress></wsdlConnection></connectionSet>"
)

XFDF = b'<xfdf xmlns="http://ns.adobe.com/xfdf/"><annots/></xfdf>'

# XFA 3.3 ch. 2 "Field Names": the fully qualified name is a SOM expression,
# dot-separated, each step carrying its occurrence index.
FIELD_NAMES = (
    "topmostSubform[0].Page1[0].name1[0]",
    "topmostSubform[0].Page1[0].name2[0]",
    "topmostSubform[0].Page1[0].group1[0].inner1[0]",
)


def build(path: Path, needs_rendering: bool) -> None:
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(400, 400))
    page.Contents = pdf.make_stream(b"BT ET")
    helv = pdf.make_indirect(
        Dictionary(
            Type=Name.Font,
            Subtype=Name.Type1,
            BaseFont=Name.Helvetica,
            Encoding=Name.WinAnsiEncoding,
        )
    )
    widgets = []
    for i, name in enumerate(FIELD_NAMES):
        widgets.append(
            pdf.make_indirect(
                Dictionary(
                    Type=Name.Annot,
                    Subtype=Name.Widget,
                    Rect=[40, 340 - i * 40, 300, 364 - i * 40],
                    F=4,
                    P=page.obj,
                    T=pikepdf.String(name),
                    FT=Name.Tx,
                    DA=pikepdf.String("/Helv 10 Tf 0 g"),
                )
            )
        )
    page.obj["/Annots"] = pikepdf.Array(widgets)

    entry = pikepdf.Array(
        [
            pikepdf.String("template"),
            pdf.make_stream(TEMPLATE),
            pikepdf.String("datasets"),
            pdf.make_stream(DATASETS),
            pikepdf.String("xfdf"),
            pdf.make_stream(XFDF),
            pikepdf.String("connectionSet"),
            pdf.make_stream(CONNECTION_SET),
        ]
    )

    pdf.Root["/AcroForm"] = pdf.make_indirect(
        Dictionary(
            Fields=pikepdf.Array(widgets),
            DA=pikepdf.String("/Helv 0 Tf 0 g"),
            DR=Dictionary(Font=Dictionary(Helv=helv)),
            XFA=entry,
        )
    )
    if needs_rendering:
        pdf.Root["/NeedsRendering"] = True
    pdf.save(str(path))
    pdf.close()


def verify(path: Path, expected: str) -> None:
    """Refuse to emit a fixture the engine reads as something else."""
    import sys

    sys.path.insert(0, str(HERE.parent.parent / "src"))
    from engine import xfa  # noqa: PLC0415

    with pikepdf.open(str(path)) as pdf:
        got = xfa.classify(pdf)
        assert got == expected, f"{path.name}: classified {got}, expected {expected}"
        assert xfa.datasets_stream(pdf) is not None, f"{path.name}: no datasets packet"


if __name__ == "__main__":
    static = HERE / "xfa-static.pdf"
    dynamic = HERE / "xfa-dynamic.pdf"
    build(static, needs_rendering=False)
    build(dynamic, needs_rendering=True)
    verify(static, "static")
    verify(dynamic, "dynamic")
    print(f"wrote {static} and {dynamic}")
