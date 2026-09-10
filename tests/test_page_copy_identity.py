"""One logical field per source; one physical widget per page occurrence."""
import io

import pikepdf
import pytest
from pikepdf import Array, Dictionary, Name

from engine.acroform import calculation_order_names
from engine.create_pdf import _subset
from engine.forms import fill_form_fields, read_form_fields
from engine.merge import merge
from engine.page_copy import copy_pages_with_forms
from engine.split import _render_part
from test_acroform_carry import _make_multi_page_form, _make_named_form


def values(path):
    return {f['name']: f['value'] for f in read_form_fields(str(path))['fields']}


def assert_graph(pdf):
    """Field kids and page annotations must be the SAME widgets, not copies."""
    tree_widgets = set()
    acro = pdf.Root.get('/AcroForm')

    def walk(node, parent=None):
        if parent is not None:
            assert node.Parent.objgen == parent.objgen
        if node.get('/Subtype') == Name.Widget:
            assert node.objgen not in tree_widgets
            tree_widgets.add(node.objgen)
        for kid in node.get('/Kids', []):
            walk(kid, node)

    if acro is not None:
        for field in acro.Fields:
            walk(field)
    visible_widgets = set()
    all_annots = set()
    for page in pdf.pages:
        for annot in page.get('/Annots', []):
            assert annot.objgen not in all_annots, 'annotation shared by two page occurrences'
            all_annots.add(annot.objgen)
            assert annot.P.objgen == page.obj.objgen
            if annot.get('/Subtype') == Name.Widget:
                visible_widgets.add(annot.objgen)
    assert visible_widgets == tree_widgets


@pytest.mark.parametrize('selection', [[0, 1, 2], [0, 2], [2, 0], [0], [2], [1], [2, 0, 2, 0]])
def test_split_keeps_shared_identity_and_private_widgets(tmp_path, selection):
    src, out, filled = (tmp_path / n for n in ('source.pdf', 'out.pdf', 'filled.pdf'))
    _make_multi_page_form(str(src))
    original = src.read_bytes()
    out.write_bytes(_render_part(str(src), selection))
    expected = values(src)
    if 0 not in selection:
        expected.pop('title')
        expected.pop('sigf')
    if 2 not in selection:
        expected.pop('only2')
    if 0 not in selection and 2 not in selection:
        expected.pop('span')
    assert values(out) == expected
    assert src.read_bytes() == original
    with pikepdf.open(out) as pdf:
        assert len(pdf.pages) == len(selection)
        assert_graph(pdf)
        for index, original_page in enumerate(selection):
            if original_page == 2:
                assert b'TAILMARKER' in pdf.pages[index].Contents.read_bytes()
    if 'span' in expected:
        fill_form_fields(str(out), str(filled), {'span': 'edited'})
        with pikepdf.open(filled) as pdf:
            assert_graph(pdf)
            shared = [f for f in pdf.Root.AcroForm.Fields if str(f.T) == 'span']
            assert len(shared) == 1
            assert len(shared[0].Kids) == sum(i in (0, 2) for i in selection)
            for kid in shared[0].Kids:
                assert str(kid.Parent.V) == 'edited'
                assert b'edited' in kid.AP.N.read_bytes()


@pytest.mark.parametrize('contributions', [1, 2, 3])
def test_merge_distinguishes_shared_widgets_from_real_name_collisions(tmp_path, contributions):
    src, out, filled = (tmp_path / n for n in ('source.pdf', 'out.pdf', 'filled.pdf'))
    _make_multi_page_form(str(src))
    original = src.read_bytes()
    result = merge([str(src)] * contributions, str(out))
    expected = {}
    for i in range(contributions):
        suffix = f'+{i}' if i else ''
        expected.update({name + suffix: value for name, value in values(src).items()})
    assert values(out) == expected
    assert src.read_bytes() == original
    assert len(result.get('fields_renamed', [])) == 5 * (contributions - 1)
    with pikepdf.open(out) as pdf:
        assert_graph(pdf)
    edits = {f'span+{i}' if i else 'span': f'value-{i}' for i in range(contributions)}
    fill_form_fields(str(out), str(filled), edits)
    with pikepdf.open(filled) as pdf:
        assert_graph(pdf)
        for i in range(contributions):
            for page_index in (3 * i, 3 * i + 2):
                widgets = [a for a in pdf.pages[page_index].Annots if a.get('/Parent') is not None]
                assert len(widgets) == 1
                assert str(widgets[0].Parent.V) == f'value-{i}'


def test_combine_member_range_uses_the_same_copy_boundary(tmp_path):
    src, out = tmp_path / 'source.pdf', tmp_path / 'out.pdf'
    _make_multi_page_form(str(src))
    assert _subset(src, out, '3,1,3', 'source.pdf') == 3
    assert values(out) == values(src)
    with pikepdf.open(out) as pdf:
        assert_graph(pdf)


@pytest.mark.parametrize('source_count', [1, 2])
def test_nested_shared_field_calculation_order_and_font_conflicts(tmp_path, source_count):
    sources = []
    for i in range(source_count):
        src = tmp_path / f'source-{i}.pdf'
        _make_multi_page_form(str(src))
        with pikepdf.open(src, allow_overwriting_input=True) as pdf:
            roots = {str(f.T): f for f in pdf.Root.AcroForm.Fields}
            shared, pure = roots['span'], roots['ghost']
            group = pdf.make_indirect(Dictionary(T=pikepdf.String('group'), FT=Name.Tx, Kids=Array([shared, pure])))
            shared.Parent = pure.Parent = group
            del shared['/FT']
            pdf.Root.AcroForm.Fields = Array([roots['title'], group, roots['sigf'], roots['only2']])
            pdf.Root.AcroForm.CO = Array([pure, shared])
            pdf.Root.AcroForm.NeedAppearances = True
            pdf.Root.AcroForm.DR.Font.Helv.BaseFont = Name.Courier if i else Name.Helvetica
            pdf.Root.AcroForm.DA = pikepdf.String(f'/Helv {8+i} Tf 0 g')
            pdf.save(src)
        sources.append(str(src))
    out = tmp_path / 'out.pdf'
    merge(sources, str(out))
    with pikepdf.open(out) as pdf:
        assert_graph(pdf)
        expected = ['group.ghost', 'group.span']
        if source_count == 2:
            expected += ['group+1.ghost', 'group+1.span']
        assert calculation_order_names(pdf) == expected
        assert pdf.Root.AcroForm.NeedAppearances
        for index, group in enumerate(f for f in pdf.Root.AcroForm.Fields if str(f.T).startswith('group')):
            shared = group.Kids[0]
            inherited_da = pikepdf.AcroFormField(shared).default_appearance.decode('ascii')
            font_key = inherited_da.split()[0]
            assert pdf.Root.AcroForm.DR.Font[font_key].BaseFont == (Name.Courier if index else Name.Helvetica)
            assert str(8+index) + ' Tf' in inherited_da


def test_repeated_combined_widget_keeps_field_actions_and_value_on_parent(tmp_path):
    src, out, filled = (tmp_path / n for n in ('source.pdf', 'out.pdf', 'filled.pdf'))
    _make_named_form(str(src), 'text', 'before')
    with pikepdf.open(src, allow_overwriting_input=True) as pdf:
        field = pdf.Root.AcroForm.Fields[0]
        field.AA = Dictionary(
            K=Dictionary(S=Name.JavaScript, JS=pikepdf.String('validate();')),
            Fo=Dictionary(S=Name.JavaScript, JS=pikepdf.String('focus();')))
        field.RV = pikepdf.String('rich before')
        field.DV = pikepdf.String('default')
        pdf.Root.AcroForm.CO = Array([field])
        pdf.save(src)
    out.write_bytes(_render_part(str(src), [0, 0, 0]))
    with pikepdf.open(out) as pdf:
        assert_graph(pdf)
        assert len(pdf.Root.AcroForm.Fields) == 1
        field = pdf.Root.AcroForm.Fields[0]
        assert field.get('/Subtype') is None
        assert set(field.AA.keys()) == {'/K'}
        assert len(field.Kids) == 3
        assert pdf.Root.AcroForm.CO[0].objgen == field.objgen
        for kid in field.Kids:
            assert set(kid.AA.keys()) == {'/Fo'}
            assert not any(k in kid for k in ('/T', '/V', '/RV', '/DV', '/FT'))
    fill_form_fields(str(out), str(filled), {'text': 'after'})
    assert values(filled) == {'text': 'after'}
    with pikepdf.open(filled) as pdf:
        assert_graph(pdf)


def test_radio_widgets_on_different_pages_stay_one_group(tmp_path):
    src, out = tmp_path / 'radio.pdf', tmp_path / 'out.pdf'
    _make_multi_page_form(str(src))
    with pikepdf.open(src, allow_overwriting_input=True) as pdf:
        radio = pdf.Root.AcroForm.Fields[1]
        radio.FT, radio.Ff, radio.V = Name.Btn, 32768, Name.A
        for kid, choice in zip(radio.Kids, ('A', 'B')):
            def appearance():
                stream = pdf.make_stream(b'')
                stream.Type, stream.Subtype, stream.BBox = Name.XObject, Name.Form, Array([0, 0, 160, 24])
                return stream
            kid.AP = Dictionary(N=Dictionary({'/Off': appearance(), '/' + choice: appearance()}))
            kid.AS = Name.A if choice == 'A' else Name.Off
        pdf.save(src)
    out.write_bytes(_render_part(str(src), [2, 0, 2]))
    with pikepdf.open(out) as pdf:
        assert_graph(pdf)
        radios = [f for f in pdf.Root.AcroForm.Fields if f.get('/FT') == Name.Btn]
        assert len(radios) == 1
        assert len(radios[0].Kids) == 3
        assert radios[0].V == Name.A
    filled = tmp_path / 'radio-filled.pdf'
    fill_form_fields(str(out), str(filled), {'span': 'B'})
    with pikepdf.open(filled) as pdf:
        assert_graph(pdf)
        for page, expected in zip(pdf.pages, (Name.B, Name.Off, Name.B)):
            widgets = [a for a in page.Annots if a.get('/Parent') is not None and str(a.Parent.get('/T')) == 'span']
            assert len(widgets) == 1
            assert widgets[0].AS == expected
            assert widgets[0].Parent.V == Name.B


def test_comment_popup_reply_identity_on_repeated_pages(tmp_path):
    src, out = tmp_path / 'comment.pdf', tmp_path / 'out.pdf'
    with pikepdf.new() as pdf:
        page = pdf.add_blank_page()
        comment = pdf.make_indirect(Dictionary(Type=Name.Annot, Subtype=Name.Text, Rect=[0, 0, 20, 20]))
        popup = pdf.make_indirect(Dictionary(Type=Name.Annot, Subtype=Name.Popup, Rect=[20, 20, 40, 40], Parent=comment))
        reply = pdf.make_indirect(Dictionary(Type=Name.Annot, Subtype=Name.Text, Rect=[40, 40, 60, 60], IRT=comment))
        comment.Popup = popup
        page.Annots = Array([comment, popup, reply])
        pdf.save(src)
    out.write_bytes(_render_part(str(src), [0, 0]))
    with pikepdf.open(out) as pdf:
        assert_graph(pdf)
        assert pdf.Root.get('/AcroForm') is None
        for page in pdf.pages:
            comment, popup, reply = page.Annots
            assert comment.Popup.objgen == popup.objgen
            assert popup.Parent.objgen == reply.IRT.objgen == comment.objgen


def test_named_destinations_are_migrated_after_annotation_copy(tmp_path):
    sources = []
    for i in range(2):
        src = tmp_path / f'links-{i}.pdf'
        _make_multi_page_form(str(src))
        with pikepdf.open(src, allow_overwriting_input=True) as pdf:
            destinations = pikepdf.NameTree.new(pdf)
            destinations['target'] = Array([pdf.pages[2].obj, Name.Fit])
            pdf.Root.Names = Dictionary(Dests=destinations.obj)
            pdf.pages[0].Annots.append(pdf.make_indirect(Dictionary(
                Type=Name.Annot, Subtype=Name.Link, Rect=[0, 0, 20, 20], Dest=pikepdf.String('target'))))
            pdf.pages[0].Annots[0].A = Dictionary(S=Name.GoTo, D=pikepdf.String('target'))
            pdf.save(src)
        sources.append(str(src))
    out = tmp_path / 'out.pdf'
    merge(sources, str(out))
    with pikepdf.open(out) as pdf:
        assert_graph(pdf)
        destinations = pikepdf.NameTree(pdf.Root.Names.Dests)
        for index, key in ((0, 'target'), (3, 'target.1')):
            assert str(pdf.pages[index].Annots[-1].Dest) == key
            assert str(pdf.pages[index].Annots[0].A.D) == key
            assert destinations[key].D[0].objgen == pdf.pages[index+2].obj.objgen


def test_malformed_annotation_set_refuses_before_replacing_output(tmp_path):
    src, out = tmp_path / 'bad.pdf', tmp_path / 'out.pdf'
    with pikepdf.new() as pdf:
        pdf.add_blank_page().Annots = Array([42])
        pdf.save(src)
    out.write_bytes(b'existing output')
    original = src.read_bytes()
    with pytest.raises(pikepdf.PdfError, match='Cannot copy'):
        merge([str(src)], str(out))
    assert out.read_bytes() == b'existing output' and src.read_bytes() == original


@pytest.mark.parametrize('bad', [42, pikepdf.String('not an array')])
def test_non_array_annotations_refuse_at_copy_boundary(bad):
    # qpdf repairs these shapes during OPEN (removes the value and warns).
    # Inject after open to actually exercise our boundary, rather than pretend
    # that the normalized file still carries the malformed dictionary value.
    with pikepdf.new() as src, pikepdf.new() as dst:
        src.add_blank_page().Annots = bad
        with pytest.raises(pikepdf.PdfError, match='non-array'):
            copy_pages_with_forms(dst, src)
        assert len(dst.pages) == 0


def test_copy_does_not_invent_a_form_on_plain_or_orphan_widget_pages():
    with pikepdf.new() as src, pikepdf.new() as dst:
        page = src.add_blank_page()
        orphan = src.make_indirect(Dictionary(Type=Name.Annot, Subtype=Name.Widget, Rect=[0, 0, 20, 20]))
        page.Annots = Array([orphan])
        copy_pages_with_forms(dst, src)
        assert dst.Root.get('/AcroForm') is None
        assert len(dst.pages[0].Annots) == 1


def test_unnamed_terminal_field_remains_registered_when_repeated():
    with pikepdf.new() as src, pikepdf.new() as dst:
        page = src.add_blank_page()
        field = src.make_indirect(Dictionary(Type=Name.Annot, Subtype=Name.Widget,
                                            FT=Name.Tx, V=pikepdf.String('value'), Rect=[0, 0, 20, 20]))
        page.Annots = Array([field])
        src.Root.AcroForm = Dictionary(Fields=Array([field]))
        copy_pages_with_forms(dst, src, [0, 0])
        buf = io.BytesIO()
        dst.save(buf)
    with pikepdf.open(buf) as pdf:
        assert_graph(pdf)
        assert len(pdf.Root.AcroForm.Fields) == 1
        assert len(pdf.Root.AcroForm.Fields[0].Kids) == 2
