import io

import pikepdf
from pikepdf import Array, Dictionary, Name, String

from engine.merge import merge
from engine.split import _render_part


def _articled(path, title, n=3):
    """One article whose beads sit one per page, in page order."""
    pdf = pikepdf.Pdf.new()
    for _ in range(n):
        pdf.add_blank_page(page_size=(200, 200))
    pages = [p.obj for p in pdf.pages]
    thread = pdf.make_indirect(Dictionary(Type=Name.Thread, I=Dictionary(Title=String(title))))
    beads = [pdf.make_indirect(Dictionary(Type=Name.Bead, P=pages[i], R=Array([0, 0, 10, 10])))
             for i in range(n)]
    for i, bead in enumerate(beads):
        bead.N = beads[(i + 1) % n]
        bead.V = beads[i - 1]
        pages[i].B = Array([bead])
    beads[0].T = thread
    thread.F = beads[0]
    pdf.Root.Threads = Array([thread])
    pdf.save(path)


def _articles(pdf):
    """[(title, [output page index of each bead in /N order])], checking that
    every ring closes, /V inverts /N, and the first bead names its thread."""
    order = [p.obj.objgen for p in pdf.pages]
    result = []
    for thread in pdf.Root.Threads:
        first, bead, positions = thread.F, thread.F, []
        assert first.T.objgen == thread.objgen
        while True:
            assert bead.N.V.objgen == bead.objgen
            assert any(b.objgen == bead.objgen for b in pdf.pages[order.index(bead.P.objgen)].obj.B)
            positions.append(order.index(bead.P.objgen))
            bead = bead.N
            if bead.objgen == first.objgen:
                break
        result.append((str(thread.I.Title), positions))
    return result


def test_merge_lists_every_contribution_article(tmp_path):
    a, b, out = tmp_path / 'a.pdf', tmp_path / 'b.pdf', tmp_path / 'out.pdf'
    _articled(a, 'A')
    _articled(b, 'B', n=2)
    merge([str(a), str(b)], str(out))
    with pikepdf.open(out) as pdf:
        assert _articles(pdf) == [('A', [0, 1, 2]), ('B', [3, 4])]


def test_split_closes_the_ring_over_kept_beads(tmp_path):
    src = tmp_path / 'src.pdf'
    _articled(src, 'A')
    with pikepdf.open(io.BytesIO(_render_part(str(src), [0, 2]))) as pdf:
        assert _articles(pdf) == [('A', [0, 1])]


def test_split_without_a_bead_page_lists_no_article(tmp_path):
    src = tmp_path / 'src.pdf'
    _articled(src, 'A')
    pdf = pikepdf.Pdf.open(src, allow_overwriting_input=True)
    del pdf.pages[1].obj['/B']
    pdf.Root.Threads[0].F.N = pdf.Root.Threads[0].F.N.N
    pdf.Root.Threads[0].F.N.V = pdf.Root.Threads[0].F
    pdf.save(src)
    pdf.close()
    with pikepdf.open(io.BytesIO(_render_part(str(src), [1]))) as out:
        assert '/Threads' not in out.Root
