import io

import pikepdf
from pikepdf import Array, Dictionary, Name, String

from engine.create_pdf import _subset
from engine.merge import merge
from engine.split import _render_part

BYTEKEY = b'\xff\x00key'


def _fixture(path, base='http://example.test/'):
    pdf = pikepdf.Pdf.new()
    for _ in range(3):
        pdf.add_blank_page(page_size=(200, 200))
    p = [page.obj for page in pdf.pages]
    pdf.Root.PageLayout = Name.TwoColumnLeft
    pdf.Root.PageMode = Name.UseThumbs
    pdf.Root.URI = Dictionary(Base=String(base))
    pdf.Root.Dests = pdf.make_indirect(Dictionary({
        '/Front': Array([p[0], Name.Fit]), '/Back': Array([p[2], Name.Fit])}))
    leaf1 = pdf.make_indirect(Dictionary(Names=Array([
        String('alpha'), Array([p[0], Name.XYZ, 0, 100, 0]),
        String('beta'), Array([p[2], Name.Fit])])))
    leaf2 = pdf.make_indirect(Dictionary(Names=Array([
        String('gamma'), pdf.make_indirect(Dictionary(D=Array([p[1], Name.Fit]))),
        String(BYTEKEY), Array([p[0], Name.FitH, 50])])))
    middle = pdf.make_indirect(Dictionary(Kids=Array([leaf1, leaf2])))
    pdf.Root.Names = Dictionary(Dests=pdf.make_indirect(Dictionary(Kids=Array([middle]))))

    def link(y, dest=None, action=None, aa=None):
        annot = Dictionary(Type=Name.Annot, Subtype=Name.Link, Rect=[0, y, 10, y + 10])
        if dest is not None:
            annot.Dest = dest
        if action is not None:
            annot.A = action
        if aa is not None:
            annot.AA = aa
        return pdf.make_indirect(annot)

    def goto(d, nxt=None):
        action = Dictionary(S=Name.GoTo, D=d)
        if nxt is not None:
            action.Next = nxt
        return action

    pdf.pages[0].obj.Annots = Array([
        link(0, dest=String('beta')),
        link(10, action=goto(String('alpha'))),
        link(20, dest=Name('/Back')),
        link(30, action=goto(String(BYTEKEY))),
        link(40, action=Dictionary(S=Name.GoToR, F=String('other.pdf'), D=String('beta'))),
        link(50, action=Dictionary(S=Name.JavaScript, JS=String('1'))),
        link(60, dest=Array([p[2], Name.Fit])),
        link(70, action=goto(String('alpha'), nxt=goto(String('gamma')))),
        link(80, aa=Dictionary(E=goto(String('beta')), X=goto(String('alpha')))),
    ])
    pdf.pages[2].obj.Annots = Array([link(0, dest=String('alpha'))])
    pdf.save(path)


def _names(pdf):
    out = {}

    def walk(node):
        for i in range(0, len(node.get('/Names', [])), 2):
            out[bytes(node.Names[i])] = node.Names[i + 1]
        for kid in node.get('/Kids', []):
            walk(kid)

    if '/Names' in pdf.Root:
        walk(pdf.Root.Names.Dests)
    return out


def _page_of(pdf, value):
    if isinstance(value, Dictionary):
        value = value.D
    return [page.obj.objgen for page in pdf.pages].index(value[0].objgen)


def _assert_first_page_part(pdf):
    assert pdf.Root.PageLayout == Name.TwoColumnLeft
    assert pdf.Root.PageMode == Name.UseThumbs
    assert bytes(pdf.Root.URI.Base) == b'http://example.test/'
    names = _names(pdf)
    assert set(names) == {b'alpha', BYTEKEY}
    assert _page_of(pdf, names[b'alpha']) == 0 and _page_of(pdf, names[BYTEKEY]) == 0
    assert list(pdf.Root.Dests.keys()) == ['/Front']
    annots = pdf.pages[0].Annots
    assert '/Dest' not in annots[0]
    assert bytes(annots[1].A.D) == b'alpha'
    assert '/Dest' not in annots[2]
    assert bytes(annots[3].A.D) == BYTEKEY
    assert annots[4].A.S == Name.GoToR and bytes(annots[4].A.D) == b'beta'
    assert annots[5].A.S == Name.JavaScript
    assert '/Dest' not in annots[6]
    assert '/A' not in annots[7]
    assert list(annots[8].AA.keys()) == ['/X']


def test_split_part_carries_catalog_and_settles_jumps(tmp_path):
    src = tmp_path / 'src.pdf'
    _fixture(src)
    with pikepdf.open(io.BytesIO(_render_part(str(src), [0]))) as pdf:
        _assert_first_page_part(pdf)


def test_create_pdf_subset_carries_catalog_and_settles_jumps(tmp_path):
    src, out = tmp_path / 'src.pdf', tmp_path / 'out.pdf'
    _fixture(src)
    _subset(src, out, '1', 'src')
    with pikepdf.open(out) as pdf:
        _assert_first_page_part(pdf)


def test_merge_makes_duplicate_names_unique_and_repoints_links(tmp_path):
    a, b, out = tmp_path / 'a.pdf', tmp_path / 'b.pdf', tmp_path / 'out.pdf'
    _fixture(a)
    _fixture(b, base='http://second.test/')
    merge([str(a), str(b)], str(out))
    with pikepdf.open(out) as pdf:
        assert bytes(pdf.Root.URI.Base) == b'http://example.test/'
        names = _names(pdf)
        assert set(names) == {b'alpha', b'beta', b'gamma', BYTEKEY,
                              b'alpha.1', b'beta.1', b'gamma.1', BYTEKEY + b'.1'}
        assert [_page_of(pdf, names[k]) for k in (b'alpha', b'beta', b'gamma', b'alpha.1', b'beta.1', b'gamma.1')] \
            == [0, 2, 1, 3, 5, 4]
        legacy = pdf.Root.Dests
        assert {k: _page_of(pdf, legacy[k]) for k in legacy.keys()} == \
            {'/Front': 0, '/Back': 2, '/Front.1': 3, '/Back.1': 5}
        second = pdf.pages[3].Annots
        assert bytes(second[0].Dest) == b'beta.1'
        assert bytes(second[1].A.D) == b'alpha.1'
        assert second[2].Dest == Name('/Back.1')
        assert bytes(second[3].A.D) == BYTEKEY + b'.1'
        assert bytes(second[4].A.D) == b'beta'
        assert bytes(second[7].A.Next.D) == b'gamma.1'
        assert _page_of(pdf, second[6].Dest) == 5
        assert bytes(pdf.pages[5].Annots[0].Dest) == b'alpha.1'
        assert bytes(pdf.pages[0].Annots[0].Dest) == b'beta'


def _presentation_source(path, **keys):
    with pikepdf.new() as pdf:
        pdf.add_blank_page()
        for key, value in keys.items():
            pdf.Root[key] = value
        pdf.save(path)


def test_merge_takes_presentation_key_from_later_source_when_first_lacks_it(tmp_path):
    a, b, out = tmp_path / 'a.pdf', tmp_path / 'b.pdf', tmp_path / 'out.pdf'
    _presentation_source(a)
    _presentation_source(b, **{'/PageLayout': Name.TwoPageLeft, '/PageMode': Name.UseOutlines,
                               '/URI': Dictionary(Base=String('http://b.test/'))})
    merge([str(a), str(b)], str(out))
    with pikepdf.open(out) as pdf:
        assert pdf.Root.PageLayout == Name.TwoPageLeft
        assert pdf.Root.PageMode == Name.UseOutlines
        assert bytes(pdf.Root.URI.Base) == b'http://b.test/'


def test_merge_presentation_conflict_resolves_to_first_definer(tmp_path):
    a, b, c, out = (tmp_path / n for n in ('a.pdf', 'b.pdf', 'c.pdf', 'out.pdf'))
    _presentation_source(a, **{'/PageMode': Name.UseThumbs})
    _presentation_source(b, **{'/PageLayout': Name.SinglePage, '/PageMode': Name.UseOutlines,
                               '/URI': Dictionary(Base=String('http://b.test/'))})
    _presentation_source(c, **{'/PageLayout': Name.TwoColumnRight,
                               '/URI': Dictionary(Base=String('http://c.test/'))})
    merge([str(a), str(b), str(c)], str(out))
    with pikepdf.open(out) as pdf:
        assert pdf.Root.PageMode == Name.UseThumbs
        assert pdf.Root.PageLayout == Name.SinglePage
        assert bytes(pdf.Root.URI.Base) == b'http://b.test/'
