import io
import re

import pikepdf
import pytest
from pikepdf import Array, Dictionary, Name, String

from engine.create_pdf import _subset
from engine.merge import merge
from engine.split import _render_part

XMP_A = b'''<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"
 xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" pdfaid:part="2" pdfaid:conformance="U">
<dc:title><rdf:Alt><rdf:li xml:lang="x-default">Source A</rdf:li></rdf:Alt></dc:title>
</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>'''


def _tagged(path, tag, *, rolemap=None, classmap=None, labels=None, lang=None,
            prefs=None, xmp=None, marked=True, attachment=None, page_mode=None, outline=True):
    """Three pages; each draws one MCID-0 paragraph; page 1 has a tagged link."""
    pdf = pikepdf.Pdf.new()
    for _ in range(3):
        pdf.add_blank_page(page_size=(200, 200))
    pages = [p.obj for p in pdf.pages]
    root = pdf.make_indirect(Dictionary(Type=Name.StructTreeRoot))
    doc = pdf.make_indirect(Dictionary(Type=Name.StructElem, S=Name('/Doc'), P=root))
    elems = []
    for i, page in enumerate(pages):
        page.Contents = pdf.make_stream(b'/P <</MCID 0>> BDC BT /F1 12 Tf (%s%d) Tj ET EMC' % (tag.encode(), i))
        page.StructParents = i
        elem = pdf.make_indirect(Dictionary(Type=Name.StructElem, S=Name('/Para'), P=doc, Pg=page, K=0,
                                            ID=String('p%d' % i), C=Name.Emph))
        elems.append(elem)
    link = pdf.make_indirect(Dictionary(Type=Name.Annot, Subtype=Name.Link, Rect=[0, 0, 10, 10],
                                        StructParent=3, P=pages[0]))
    link.A = Dictionary(S=Name.GoTo, D=Array([pages[2], Name.Fit]), SD=Array([elems[2]]))
    pages[0].Annots = Array([link])
    link_elem = pdf.make_indirect(Dictionary(Type=Name.StructElem, S=Name.Link, P=doc, Pg=pages[0],
                                             K=Dictionary(Type=Name.OBJR, Obj=link)))
    doc.K = Array(elems + [link_elem])
    root.K = doc
    root.ParentTree = pdf.make_indirect(Dictionary(Nums=Array([
        0, Array([elems[0]]), 1, Array([elems[1]]), 2, Array([elems[2]]), 3, link_elem])))
    root.ParentTreeNextKey = 4
    root.RoleMap = Dictionary(rolemap or {'/Doc': Name.Document, '/Para': Name.P})
    root.ClassMap = Dictionary(classmap or {'/Emph': Dictionary(O=Name.Layout, Color=Array([1, 0, 0]))})
    root.IDTree = pdf.make_indirect(Dictionary(Names=Array(
        [x for i in range(3) for x in (String('p%d' % i), elems[i])])))
    pdf.Root.StructTreeRoot = root
    pdf.Root.MarkInfo = Dictionary(Marked=marked)
    if outline:
        with pdf.open_outline() as ol:
            first = pikepdf.OutlineItem(f'{tag} first', 0)
            first.children.append(pikepdf.OutlineItem(f'{tag} last', 2))
            ol.root.append(first)
            ol.root.append(pikepdf.OutlineItem(f'{tag} middle', 1))
        pdf.Root.Outlines.First.SE = doc
    if labels is not None:
        pdf.Root.PageLabels = Dictionary(Nums=Array(labels))
    if lang is not None:
        pdf.Root.Lang = String(lang)
    if prefs is not None:
        pdf.Root.ViewerPreferences = prefs
    if xmp is not None:
        pdf.Root.Metadata = pdf.make_stream(xmp, Type=Name.Metadata, Subtype=Name.XML)
    if attachment is not None:
        spec = pdf.make_indirect(Dictionary(Type=Name.Filespec, F=String(attachment[0]), UF=String(attachment[0]),
                                            EF=Dictionary(F=pdf.make_stream(attachment[1], Type=Name.EmbeddedFile))))
        pdf.Root.Names = Dictionary(EmbeddedFiles=Dictionary(Names=Array([String(attachment[0]), spec])))
    if page_mode is not None:
        pdf.Root.PageMode = Name(page_mode)
    pdf.save(path)


def _plain(path, n=2):
    pdf = pikepdf.Pdf.new()
    for _ in range(n):
        pdf.add_blank_page(page_size=(100, 100))
    pdf.save(path)


def _index(pdf, page):
    return [p.obj.objgen for p in pdf.pages].index(page.objgen)


def _outline(pdf):
    out = []
    with pdf.open_outline() as ol:
        def walk(items, depth):
            for item in items:
                dest = item.destination
                page = _index(pdf, dest[0]) if isinstance(dest, Array) and isinstance(dest[0], Dictionary) else None
                out.append((depth, item.title, page))
                walk(item.children, depth + 1)
        walk(ol.root, 0)
    return out


def _mcids(page):
    data = page.obj.Contents.read_bytes() if isinstance(page.obj.Contents, pikepdf.Stream) else b''
    return {int(m) for m in re.findall(rb'/MCID (\d+)', data)}


def _assert_structure(pdf):
    """ParentTree consistency (14.7.5.4): every page MCID and every tagged
    annotation resolves to an element that owns it; every element is reachable
    once from the root with a correct /P; no reference leads to null."""
    root = pdf.Root.StructTreeRoot
    nums = list(root.ParentTree.Nums)
    tree = {nums[i]: nums[i + 1] for i in range(0, len(nums), 2)}
    assert all(k < root.ParentTreeNextKey for k in tree)
    parents = {}

    def walk(node, parent, pg):
        assert node.P.objgen == parent.objgen
        pg = node.get('/Pg', pg)
        assert parents.setdefault(node.objgen, parent.objgen) == parent.objgen
        kids = node.K if isinstance(node.get('/K'), Array) else [node.get('/K')] if '/K' in node else []
        owned = []
        for kid in kids:
            if isinstance(kid, int):
                owned.append(('mcid', pg.objgen, kid))
            elif kid.get('/Type') == Name.OBJR:
                owned.append(('objr', kid.Obj.objgen))
            elif kid.get('/Type') == Name.MCR:
                owned.append(('mcid', kid.get('/Pg', pg).objgen, kid.MCID))
            else:
                walk(kid, node, pg)
        for item in owned:
            yield_to.append((item, node.objgen))

    yield_to = []
    kids = root.K if isinstance(root.K, Array) else [root.K]
    for top in kids:
        walk(top, root, None)
    owners = dict(yield_to)
    page_keys = set()
    for page in pdf.pages:
        mcids = _mcids(page)
        if not mcids:
            continue
        key = page.obj.StructParents
        page_keys.add(key)
        entry = tree[key]
        for mcid in mcids:
            assert owners[('mcid', page.obj.objgen, mcid)] == entry[mcid].objgen
        for annot in page.obj.get('/Annots', []):
            if '/StructParent' in annot:
                assert owners[('objr', annot.objgen)] == tree[annot.StructParent].objgen
    for (kind, *rest), owner in owners.items():
        if kind == 'mcid':
            assert rest[0] in {p.obj.objgen for p in pdf.pages}


def _saved(pdf_bytes_or_path):
    return pikepdf.open(io.BytesIO(pdf_bytes_or_path) if isinstance(pdf_bytes_or_path, bytes) else pdf_bytes_or_path)


def _count_type(path, kind):
    with pikepdf.open(path) as pdf:
        return sum(1 for obj in pdf.objects if isinstance(obj, Dictionary) and obj.get('/Type') == kind)


# -- outlines ------------------------------------------------------------------
def test_merge_concatenates_outlines_onto_copied_pages(tmp_path):
    a, b, out = tmp_path / 'a.pdf', tmp_path / 'b.pdf', tmp_path / 'out.pdf'
    _tagged(a, 'A')
    _tagged(b, 'B')
    merge([str(a), str(b)], str(out))
    with pikepdf.open(out) as pdf:
        assert _outline(pdf) == [(0, 'A first', 0), (1, 'A last', 2), (0, 'A middle', 1),
                                 (0, 'B first', 3), (1, 'B last', 5), (0, 'B middle', 4)]
        assert pdf.Root.Outlines.Count == 6
        firsts = [pdf.Root.Outlines.First, pdf.Root.Outlines.First.Next.Next]
        assert all(f.SE.S == Name('/Doc') and f.SE.P.objgen == pdf.Root.StructTreeRoot.objgen for f in firsts)


def test_split_keeps_outline_items_and_drops_only_dangling_jumps(tmp_path):
    src = tmp_path / 'src.pdf'
    _tagged(src, 'A')
    with _saved(_render_part(str(src), [1, 2])) as pdf:
        assert _outline(pdf) == [(0, 'A first', None), (1, 'A last', 1), (0, 'A middle', 0)]
        assert '/Dest' not in pdf.Root.Outlines.First


def test_page_mode_use_outlines_needs_a_carried_outline(tmp_path):
    a, out = tmp_path / 'a.pdf', tmp_path / 'out.pdf'
    _tagged(a, 'A', page_mode='/UseOutlines', outline=False)
    merge([str(a)], str(out))
    with pikepdf.open(out) as pdf:
        assert '/PageMode' not in pdf.Root
    _tagged(a, 'A', page_mode='/UseOutlines')
    merge([str(a)], str(out))
    with pikepdf.open(out) as pdf:
        assert pdf.Root.PageMode == Name.UseOutlines


# -- page labels ---------------------------------------------------------------
def _labels(pdf):
    nums = list(pdf.Root.PageLabels.Nums)
    out = []
    for i in range(0, len(nums), 2):
        d = nums[i + 1]
        out.append((nums[i], str(d.get('/S')) if '/S' in d else None,
                    bytes(d.P) if '/P' in d else None, d.get('/St', 1)))
    return out


def test_merge_rebases_page_labels_and_numbers_unlabelled_sources(tmp_path):
    a, b, out = tmp_path / 'a.pdf', tmp_path / 'b.pdf', tmp_path / 'out.pdf'
    _plain(a, 2)
    _tagged(b, 'B', labels=[0, Dictionary(S=Name.r), 1, Dictionary(S=Name.D, P=String('B-'), St=5)])
    merge([str(a), str(b)], str(out))
    with pikepdf.open(out) as pdf:
        assert _labels(pdf) == [(0, '/D', None, 1), (2, '/r', None, 1), (3, '/D', b'B-', 5)]


def test_split_resolves_labels_of_kept_pages(tmp_path):
    src = tmp_path / 'src.pdf'
    _tagged(src, 'A', labels=[0, Dictionary(S=Name.D, P=String('A-'), St=10)])
    with _saved(_render_part(str(src), [1, 2])) as pdf:
        assert _labels(pdf) == [(0, '/D', b'A-', 11)]


# -- embedded files ------------------------------------------------------------
def test_merge_merges_embedded_files_with_unique_names(tmp_path):
    a, b, out = tmp_path / 'a.pdf', tmp_path / 'b.pdf', tmp_path / 'out.pdf'
    _tagged(a, 'A', attachment=('data.txt', b'first'), page_mode='/UseAttachments')
    _tagged(b, 'B', attachment=('data.txt', b'second'))
    merge([str(a), str(b)], str(out))
    with pikepdf.open(out) as pdf:
        names = list(pdf.Root.Names.EmbeddedFiles.Names)
        files = {bytes(names[i]): names[i + 1].EF.F.read_bytes() for i in range(0, len(names), 2)}
        assert files == {b'data.txt': b'first', b'data.txt.1': b'second'}
        assert pdf.Root.PageMode == Name.UseAttachments


# -- language, viewer preferences, metadata ------------------------------------
def test_lang_and_viewer_preferences_are_first_definer(tmp_path):
    a, b, out = tmp_path / 'a.pdf', tmp_path / 'b.pdf', tmp_path / 'out.pdf'
    _plain(a, 1)
    _tagged(b, 'B', lang='de-DE', prefs=Dictionary(DisplayDocTitle=True, PrintPageRange=Array([2, 3])))
    _tagged(tmp_path / 'c.pdf', 'C', lang='fr-FR', prefs=Dictionary(HideToolbar=True))
    merge([str(a), str(b), str(tmp_path / 'c.pdf')], str(out))
    with pikepdf.open(out) as pdf:
        assert bytes(pdf.Root.Lang) == b'de-DE'
        assert pdf.Root.ViewerPreferences.DisplayDocTitle is True
        assert '/HideToolbar' not in pdf.Root.ViewerPreferences
        assert list(pdf.Root.ViewerPreferences.PrintPageRange) == [1, 1, 3, 7]
    with _saved(_render_part(str(b), [0, 2])) as pdf:
        assert list(pdf.Root.ViewerPreferences.PrintPageRange) == [2, 2]


def test_metadata_carries_and_loses_a_claim_not_every_part_makes(tmp_path):
    a, b, out = tmp_path / 'a.pdf', tmp_path / 'b.pdf', tmp_path / 'out.pdf'
    _tagged(a, 'A', xmp=XMP_A)
    _tagged(b, 'B')
    with _saved(_render_part(str(a), [0])) as pdf:
        assert b'pdfaid:part="2"' in pdf.Root.Metadata.read_bytes()
    merge([str(a), str(b)], str(out))
    with pikepdf.open(out) as pdf:
        data = pdf.Root.Metadata.read_bytes()
        assert b'Source A' in data and b'pdfa/ns/id' not in data
    merge([str(a), str(a)], str(out))
    with pikepdf.open(out) as pdf:
        assert b'pdfaid:part="2"' in pdf.Root.Metadata.read_bytes()


# -- structure -----------------------------------------------------------------
def test_merge_carries_both_structure_trees_consistently(tmp_path):
    a, b, out = tmp_path / 'a.pdf', tmp_path / 'b.pdf', tmp_path / 'out.pdf'
    _tagged(a, 'A')
    _tagged(b, 'B')
    merge([str(a), str(b)], str(out))
    with pikepdf.open(out) as pdf:
        root = pdf.Root.StructTreeRoot
        assert pdf.Root.MarkInfo.Marked is True
        assert len(root.K) == 2
        _assert_structure(pdf)
        ids = list(root.IDTree.Names)
        assert [bytes(ids[i]) for i in range(0, len(ids), 2)] == [b'p0', b'p0.1', b'p1', b'p1.1', b'p2', b'p2.1']
        link = pdf.pages[3].Annots[0]
        assert link.A.SD[0].objgen == root.K[1].K[2].objgen
    assert _count_type(out, Name.StructTreeRoot) == 1


def test_split_prunes_structure_of_dropped_pages(tmp_path):
    src = tmp_path / 'src.pdf'
    _tagged(src, 'A')
    data = _render_part(str(src), [1])
    with _saved(data) as pdf:
        doc = pdf.Root.StructTreeRoot.K[0]
        kids = doc.K if isinstance(doc.K, Array) else [doc.K]
        assert [bytes(k.ID) for k in kids] == [b'p1']
        _assert_structure(pdf)
    part = src.parent / 'part.pdf'
    part.write_bytes(data)
    assert _count_type(part, Name.StructTreeRoot) == 1


def test_repeated_page_is_tagged_per_occurrence(tmp_path):
    src, out = tmp_path / 'src.pdf', tmp_path / 'out.pdf'
    _tagged(src, 'A')
    _subset(src, out, '1,1', 'src')
    with pikepdf.open(out) as pdf:
        assert pdf.pages[0].obj.StructParents != pdf.pages[1].obj.StructParents
        _assert_structure(pdf)


def test_mark_info_is_marked_only_when_every_source_is(tmp_path):
    a, b, out = tmp_path / 'a.pdf', tmp_path / 'b.pdf', tmp_path / 'out.pdf'
    _tagged(a, 'A')
    _plain(b)
    merge([str(a), str(b)], str(out))
    with pikepdf.open(out) as pdf:
        assert pdf.Root.MarkInfo.Marked is False
        _assert_structure(pdf)


def test_conflicting_role_and_class_maps_rename_the_mapped_side(tmp_path):
    a, b, out = tmp_path / 'a.pdf', tmp_path / 'b.pdf', tmp_path / 'out.pdf'
    _tagged(a, 'A')
    _tagged(b, 'B', rolemap={'/Doc': Name.Part, '/Para': Name.P},
            classmap={'/Emph': Dictionary(O=Name.Layout, Color=Array([0, 0, 1]))})
    merge([str(a), str(b)], str(out))
    with pikepdf.open(out) as pdf:
        root = pdf.Root.StructTreeRoot
        rolemap = {k: str(v) for k, v in root.RoleMap.items()}
        assert rolemap['/Doc'] == '/Document' and rolemap['/Para'] == '/P'
        renamed = str(root.K[1].S)
        assert renamed != '/Doc' and rolemap[renamed] == '/Part'
        cls = str(root.K[1].K[0].C)
        assert cls != '/Emph' and list(root.ClassMap[cls].Color) == [0, 0, 1]
        assert list(root.ClassMap.Emph.Color) == [1, 0, 0]


def test_untagged_copy_drops_stale_struct_parent_keys(tmp_path):
    src, out = tmp_path / 'src.pdf', tmp_path / 'out.pdf'
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page()
    pdf.pages[0].obj.StructParents = 7
    pdf.save(src)
    merge([str(src)], str(out))
    with pikepdf.open(out) as result:
        assert '/StructParents' not in result.pages[0].obj
        assert '/StructTreeRoot' not in result.Root and '/MarkInfo' not in result.Root


@pytest.mark.parametrize('pages', [[0, 1, 2], [2]])
def test_split_structure_survives_every_selection(tmp_path, pages):
    src = tmp_path / 'src.pdf'
    _tagged(src, 'A')
    with _saved(_render_part(str(src), pages)) as pdf:
        _assert_structure(pdf)


def test_named_structure_destination_follows_its_carried_element(tmp_path):
    src, out = tmp_path / 'src.pdf', tmp_path / 'out.pdf'
    _tagged(src, 'A')
    with pikepdf.open(src, allow_overwriting_input=True) as pdf:
        elem = pdf.Root.StructTreeRoot.K.K[1]
        pdf.Root.Names = Dictionary(Dests=Dictionary(Names=Array([
            String('s'), Dictionary(D=Array([pdf.pages[1].obj, Name.Fit]), SD=Array([elem, Name.Fit]))])))
        pdf.save(src)
    merge([str(src)], str(out))
    with pikepdf.open(out) as pdf:
        entry = pdf.Root.Names.Dests.Names[1]
        target = pdf.Root.StructTreeRoot.K[0].K[1]
        assert entry.SD[0].objgen == target.objgen and bytes(target.ID) == b'p1'


def test_print_range_selecting_no_copied_page_is_an_empty_range(tmp_path):
    src = tmp_path / 'src.pdf'
    _tagged(src, 'A', prefs=Dictionary(PrintPageRange=Array([3, 3])))
    with _saved(_render_part(str(src), [0, 1])) as pdf:
        assert list(pdf.Root.ViewerPreferences.PrintPageRange) == []


def test_outline_items_sharing_one_action_both_settle(tmp_path):
    src = tmp_path / 'src.pdf'
    _tagged(src, 'A')
    with pikepdf.open(src, allow_overwriting_input=True) as pdf:
        dead = pdf.make_indirect(Dictionary(S=Name.GoTo, D=Array([pdf.pages[2].obj, Name.Fit]),
                                            Next=Dictionary(S=Name.GoTo, D=Array([pdf.pages[1].obj, Name.Fit]))))
        first = pdf.Root.Outlines.First
        for item in (first, first.Next):
            if '/Dest' in item:
                del item['/Dest']
            item.A = dead
        pdf.save(src)
    with _saved(_render_part(str(src), [0, 1])) as pdf:
        first = pdf.Root.Outlines.First
        for item in (first, first.Next):
            assert item.A.S == Name.GoTo and '/Next' not in item.A
            assert _index(pdf, item.A.D[0]) == 1


def test_sparse_large_mcid_resolves_and_budget_refuses(tmp_path):
    src, out = tmp_path / 'src.pdf', tmp_path / 'out.pdf'
    _tagged(src, 'A')
    with pikepdf.open(src, allow_overwriting_input=True) as pdf:
        pdf.pages[1].obj.Contents = pdf.make_stream(b'/P <</MCID 5000>> BDC EMC')
        pdf.Root.StructTreeRoot.K.K[1].K = 5000
        pdf.save(src)
    merge([str(src)], str(out))
    with pikepdf.open(out) as pdf:
        entry = pdf.Root.StructTreeRoot.ParentTree.Nums[3]
        assert len(entry) == 5001 and bytes(entry[5000].ID) == b'p1'
        _assert_structure(pdf)
    with pikepdf.open(src, allow_overwriting_input=True) as pdf:
        pdf.Root.StructTreeRoot.K.K[1].K = 5_000_000
        pdf.save(src)
    with pytest.raises(ValueError, match='too deep or too large'):
        merge([str(src)], str(out))


def test_page_copied_twice_tags_each_link_occurrence(tmp_path, monkeypatch):
    from engine import catalog_carry
    src, out = tmp_path / 'src.pdf', tmp_path / 'out.pdf'
    _tagged(src, 'A')
    built = []
    original = catalog_carry.StructCarry._payload
    monkeypatch.setattr(catalog_carry.StructCarry, '_payload',
                        lambda self, dst, elem, new, *a: (built.append(str(elem.S)), original(self, dst, elem, new, *a)))
    _subset(src, out, '1,2,3,1', 'src')
    # Pass 0 builds Doc, three paragraphs and the link; the repeat pass
    # visits only what reaches page 1: Doc, its paragraph and the link.
    assert sorted(built) == sorted(['/Doc', '/Para', '/Para', '/Para', '/Link', '/Doc', '/Para', '/Link'])
    with pikepdf.open(out) as pdf:
        _assert_structure(pdf)
        first, last = pdf.pages[0].Annots[0], pdf.pages[3].Annots[0]
        assert first.objgen != last.objgen and first.StructParent != last.StructParent
        tree = dict(zip(*[iter(pdf.Root.StructTreeRoot.ParentTree.Nums)] * 2))
        assert tree[first.StructParent].K.Obj.objgen == first.objgen
        assert tree[last.StructParent].K.Obj.objgen == last.objgen
