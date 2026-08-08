"""Build `derived-nav.pdf` — the P29 end-to-end fixture.

Two pages, both tagged. Page 1 carries an H1 and an H2 with real marked
content; page 2 carries an H1 and a line of prose with a web address and an
email address in it. So one document exercises both derivations: bookmarks
from the structure, and links from the text.

Run from the repo root:
    .venv/Scripts/python.exe e2e-tests/fixtures/make-derived-nav-fixture.py
"""

from pathlib import Path

import pikepdf

OUT = Path(__file__).with_name("derived-nav.pdf")

PAGES = [
    [
        ("H1", "Introduction", 700, 22),
        ("H2", "Scope and purpose", 650, 16),
        ("P", "This document describes the process.", 610, 11),
    ],
    [
        ("H1", "References", 700, 22),
        ("P", "See https://example.com/spec and write to editor@example.org.", 650, 11),
    ],
]


def build() -> None:
    pdf = pikepdf.Pdf.new()
    font = pdf.make_indirect(
        pikepdf.Dictionary(
            Type=pikepdf.Name.Font,
            Subtype=pikepdf.Name.Type1,
            BaseFont=pikepdf.Name.Helvetica,
        )
    )
    root = pdf.make_indirect(pikepdf.Dictionary(Type=pikepdf.Name.StructTreeRoot))
    doc_elem = pdf.make_indirect(
        pikepdf.Dictionary(Type=pikepdf.Name.StructElem, S=pikepdf.Name.Document, P=root)
    )
    doc_kids = pikepdf.Array()
    nums = pikepdf.Array()

    for index, blocks in enumerate(PAGES):
        page = pdf.add_blank_page(page_size=(612, 792))
        body = []
        elements = pikepdf.Array()
        for mcid, (tag, text, y, size) in enumerate(blocks):
            body.append(
                f"/{tag} <</MCID {mcid}>> BDC BT /F1 {size} Tf 72 {y} Td ({text}) Tj ET EMC"
            )
            elem = pdf.make_indirect(
                pikepdf.Dictionary(
                    Type=pikepdf.Name.StructElem,
                    S=pikepdf.Name("/" + tag),
                    P=doc_elem,
                    Pg=page.obj,
                    K=mcid,
                )
            )
            doc_kids.append(elem)
            elements.append(elem)
        page.obj[pikepdf.Name.Contents] = pdf.make_stream("\n".join(body).encode("ascii"))
        page.obj[pikepdf.Name.Resources] = pikepdf.Dictionary(
            Font=pikepdf.Dictionary(F1=font)
        )
        page.obj[pikepdf.Name.StructParents] = index
        nums.append(index)
        nums.append(pdf.make_indirect(elements))

    doc_elem[pikepdf.Name.K] = doc_kids
    root[pikepdf.Name.K] = doc_elem
    root[pikepdf.Name.ParentTree] = pdf.make_indirect(pikepdf.Dictionary(Nums=nums))
    root[pikepdf.Name.ParentTreeNextKey] = len(PAGES)
    pdf.Root[pikepdf.Name.StructTreeRoot] = root
    pdf.Root[pikepdf.Name.MarkInfo] = pikepdf.Dictionary(Marked=True)
    pdf.save(OUT)
    print(f"wrote {OUT}")


if __name__ == "__main__":
    build()
