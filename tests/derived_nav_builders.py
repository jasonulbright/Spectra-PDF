"""Fixtures for the derived-navigation tests, built in code.

The `transparency_builders` discipline: what the page contains is known before
anything runs, so a failure is a defect in the code under test rather than an
unexplained property of a checked-in file.
"""

import pikepdf

_HELV = None


def _font(pdf):
    return pdf.make_indirect(
        pikepdf.Dictionary(
            Type=pikepdf.Name.Font,
            Subtype=pikepdf.Name.Type1,
            BaseFont=pikepdf.Name.Helvetica,
        )
    )


def blank_pdf(pages=1, size=(400, 600)):
    pdf = pikepdf.Pdf.new()
    for _ in range(pages):
        pdf.add_blank_page(page_size=size)
    return pdf


def draw_marked(pdf, page, blocks):
    """Write `blocks` — (mcid, text, y, size) — as marked-content text.

    Every block is wrapped in `/P <</MCID n>> BDC … EMC`, the shape a tagged
    document actually has, so the MCID → text resolution is exercised on real
    marked content rather than on a convenience.
    """
    font = _font(pdf)
    parts = []
    for mcid, text, y, size in blocks:
        parts.append(
            f"/P <</MCID {mcid}>> BDC BT /F1 {size} Tf 50 {y} Td ({text}) Tj ET EMC"
        )
    page.obj[pikepdf.Name.Contents] = pdf.make_stream("\n".join(parts).encode("ascii"))
    page.obj[pikepdf.Name.Resources] = pikepdf.Dictionary(
        Font=pikepdf.Dictionary(F1=font)
    )


def struct_root(pdf):
    root = pdf.make_indirect(pikepdf.Dictionary(Type=pikepdf.Name.StructTreeRoot))
    pdf.Root[pikepdf.Name.StructTreeRoot] = root
    pdf.Root[pikepdf.Name.MarkInfo] = pikepdf.Dictionary(Marked=True)
    return root


def elem(pdf, tag, parent, page=None, mcid=None, **extra):
    d = pikepdf.Dictionary(
        Type=pikepdf.Name.StructElem, S=pikepdf.Name("/" + tag), P=parent
    )
    if page is not None:
        d[pikepdf.Name.Pg] = page.obj
    if mcid is not None:
        d[pikepdf.Name.K] = mcid
    for key, value in extra.items():
        d[pikepdf.Name("/" + key)] = pikepdf.String(value)
    return pdf.make_indirect(d)


def attach(parent, kids):
    parent[pikepdf.Name.K] = pikepdf.Array(kids)


def wire_parent_tree(pdf, root, per_page):
    """`per_page` is [(page, [elements])] in page order."""
    nums = pikepdf.Array()
    for key, (page, elements) in enumerate(per_page):
        page.obj[pikepdf.Name.StructParents] = key
        nums.append(key)
        nums.append(pdf.make_indirect(pikepdf.Array(elements)))
    root[pikepdf.Name.ParentTree] = pdf.make_indirect(pikepdf.Dictionary(Nums=nums))
    root[pikepdf.Name.ParentTreeNextKey] = len(per_page)


def simple_headed_doc(path, tags=("H1", "H2", "H3")):
    """A one-page document with one heading per tag, in order, each with real
    marked-content text: `Alpha`, `Beta`, `Gamma`…"""
    names = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta"]
    pdf = blank_pdf(1)
    page = pdf.pages[0]
    blocks = [(i, names[i], 500 - i * 40, 20 - i * 2) for i in range(len(tags))]
    draw_marked(pdf, page, blocks)
    root = struct_root(pdf)
    kids = [elem(pdf, tag, root, page=page, mcid=i) for i, tag in enumerate(tags)]
    attach(root, kids)
    wire_parent_tree(pdf, root, [(page, kids)])
    pdf.save(path)
    return [names[i] for i in range(len(tags))]


def untagged_text_doc(path):
    """One page of PLAIN text — no structure tree and no marked content."""
    pdf = blank_pdf(1)
    page = pdf.pages[0]
    font = _font(pdf)
    body = "\n".join(
        [
            "BT /F1 24 Tf 50 520 Td (Chapter One) Tj ET",
            "BT /F1 10 Tf 50 480 Td (Body text on the page.) Tj ET",
        ]
    )
    page.obj[pikepdf.Name.Contents] = pdf.make_stream(body.encode("ascii"))
    page.obj[pikepdf.Name.Resources] = pikepdf.Dictionary(
        Font=pikepdf.Dictionary(F1=font)
    )
    pdf.save(path)
    return path
